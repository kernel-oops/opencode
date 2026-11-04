import { AIError, TransportError } from "../schema/index.js"
import type {
  ChannelCheckpoint,
  ChannelCreate,
  ChannelObservation,
  WebSocketChannelDriver,
} from "../route/transport/index.js"
import { Effect, Option, Schema } from "effect"
import * as ProviderShared from "./shared.js"
import { OpenResponses } from "./open-responses.js"

const PROTOCOL = "open-responses.websocket.v1"
const VERSION = 1

interface CheckpointValue {
  readonly version: typeof VERSION
  readonly responseID: string
  readonly request: Readonly<Record<string, unknown>>
  readonly output: ReadonlyArray<unknown>
  readonly steer?: string
  readonly automatic?: boolean
}

/**
 * Fields to send next to `previous_response_id` on an incremental step, or undefined to send the step in full.
 * Whether omitted fields carry over from the continued response is provider behavior the route must know.
 */
export type Shape = (request: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | undefined

export interface BaseDriver extends WebSocketChannelDriver {
  readonly observeEvent?: (
    create: ChannelCreate,
    frame: string,
    event: OpenResponses.Event,
  ) => Effect.Effect<ChannelObservation, AIError>
}

export interface DriverInput {
  readonly id: string
  readonly name: string
  readonly request: Readonly<Record<string, unknown>>
  readonly message: string
  readonly base: BaseDriver
  readonly continuation?: Shape
  readonly steering?: boolean
}

const checkpointValue = (checkpoint: ChannelCheckpoint | undefined): CheckpointValue | undefined => {
  if (checkpoint?.protocol !== PROTOCOL || !ProviderShared.isRecord(checkpoint.value)) return undefined
  if (checkpoint.value.version !== VERSION) return undefined
  if (typeof checkpoint.value.responseID !== "string" || checkpoint.value.responseID.trim().length === 0)
    return undefined
  if (!ProviderShared.isRecord(checkpoint.value.request) || !Array.isArray(checkpoint.value.output)) return undefined
  return {
    version: VERSION,
    responseID: checkpoint.value.responseID,
    request: checkpoint.value.request,
    output: checkpoint.value.output,
    steer: typeof checkpoint.value.steer === "string" ? checkpoint.value.steer : undefined,
    automatic: checkpoint.value.automatic === true,
  }
}

const canonical = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (!ProviderShared.isRecord(value)) return ProviderShared.encodeJson(value)
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${ProviderShared.encodeJson(key)}:${canonical(value[key])}`)
    .join(",")}}`
}

const json = (value: unknown) => {
  if (typeof value !== "string") return value
  return Option.getOrElse(Schema.decodeUnknownOption(ProviderShared.Json)(value), () => value)
}

const comparable = (value: unknown) => {
  if (!ProviderShared.isRecord(value)) return value
  if (value.type === "message" && value.role === "assistant")
    return {
      role: "assistant",
      // Annotations and logprobs describe the response, not the text replayed in model input.
      content: Array.isArray(value.content)
        ? value.content.map((part) =>
            ProviderShared.isRecord(part) && part.type === "output_text" ? { type: part.type, text: part.text } : part,
          )
        : value.content,
      ...(value.phase === undefined ? {} : { phase: value.phase }),
    }
  if (value.type === "function_call")
    return {
      type: value.type,
      call_id: value.call_id,
      name: value.name,
      arguments: json(value.arguments),
    }
  if (value.type === "reasoning")
    return {
      type: value.type,
      summary: value.summary,
      encrypted_content: value.encrypted_content,
    }
  return value
}

const invariant = (request: Readonly<Record<string, unknown>>) => {
  const { type: _type, input: _input, previous_response_id: _previousResponseID, ...rest } = request
  return rest
}

const incremental = (
  request: Readonly<Record<string, unknown>>,
  checkpoint: CheckpointValue,
): ReadonlyArray<unknown> | undefined => {
  const input = request.input
  const previousInput = checkpoint.request.input
  if (!Array.isArray(input) || !Array.isArray(previousInput)) return undefined
  if (canonical(invariant(request)) !== canonical(invariant(checkpoint.request))) return undefined
  const baseline = [...previousInput, ...checkpoint.output]
  if (input.length < baseline.length) return undefined
  if (!baseline.every((item, index) => canonical(comparable(item)) === canonical(comparable(input[index]))))
    return undefined
  return input.slice(baseline.length)
}

const code = (event: OpenResponses.Event) => OpenResponses.errorDetail(event).code

const rejected = (
  observation: Extract<ChannelObservation, { readonly type: "provider-failure" }>,
  recovery: "retry-full" | "rotate-and-retry-full",
): ChannelObservation => ({
  type: "rejected",
  recovery,
  error: new AIError({
    reason: new TransportError({
      message: observation.error.message,
      body: observation.error.reason.body,
      http: observation.error.reason.http,
      cause: observation.error.reason.cause,
      transport: "websocket",
      operation: "read",
      phase: "receive",
      delivery: "rejected",
      recovery,
    }),
  }),
})

const unsupported = new Set<string>()
const decodeSteer = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.optional(Schema.NonEmptyString),
    previous_response_id: Schema.NonEmptyString,
  }),
)

export const driver = (input: DriverInput): WebSocketChannelDriver => {
  const { previous_response_id: _previousResponseID, ...request } = input.request
  const shape = input.continuation ?? ((fields: Readonly<Record<string, unknown>>) => fields)
  let output: OpenResponses.StreamItem[] = []
  let responseID: string | undefined
  let steer: string | undefined
  let accepted = false
  let steerID: string | undefined
  let terminal: Extract<ChannelObservation, { type: "completed" | "incomplete" }> | undefined
  const handoff = (automatic: boolean, continuation?: string): ChannelObservation => ({
    ...terminal!,
    continuation,
    checkpoint: {
      protocol: PROTOCOL,
      pendingInput: true,
      value: {
        ...checkpointValue(terminal!.checkpoint)!,
        steer,
        automatic,
      } satisfies CheckpointValue,
    },
  })
  return {
    steer: input.steering
      ? (text) =>
          Effect.sync(() => {
            // shortcut: one update per response; additional messages use the normal inbox boundary.
            if (
              !responseID ||
              terminal ||
              steer !== undefined ||
              !text.trim() ||
              unsupported.has(String(request.model))
            )
              return undefined
            steer = text
            return ProviderShared.encodeJson({ type: "response.steer", previous_response_id: responseID, input: text })
          })
      : undefined,
    create: (checkpoint) =>
      input.base.create(undefined).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            output = []
            const previous = checkpointValue(checkpoint)
            // Ask the route first: diffing the whole history is wasted when it declines the continuation.
            const fields = previous ? shape(request) : undefined
            const delta = previous && fields ? incremental(request, previous) : undefined
            if (previous?.automatic && (!fields || !delta))
              return yield* new AIError({
                reason: new TransportError({
                  message: "Conversation changed before the automatic steering continuation",
                  transport: "websocket",
                  operation: "request",
                  recovery: "rotate-and-retry-full",
                }),
              })
            if (!previous || !fields || !delta || (delta.length === 0 && previous.steer === undefined))
              return { message: ProviderShared.encodeJson(request), mode: "full" as const }
            const steerIndex =
              previous.steer === undefined
                ? -1
                : delta.findIndex(
                    (item) =>
                      ProviderShared.isRecord(item) &&
                      item.role === "user" &&
                      Array.isArray(item.content) &&
                      item.content.length === 1 &&
                      ProviderShared.isRecord(item.content[0]) &&
                      item.content[0].type === "input_text" &&
                      item.content[0].text === previous.steer,
                  )
            if (previous.steer !== undefined && steerIndex === -1)
              return yield* new AIError({
                reason: new TransportError({
                  message: "Accepted steering is missing from canonical history",
                  transport: "websocket",
                  operation: "request",
                  recovery: "rotate-and-retry-full",
                }),
              })
            const remaining = delta.filter((_, index) => index !== steerIndex)
            if (previous.automatic) {
              if (remaining.length > 0)
                return yield* new AIError({
                  reason: new TransportError({
                    message: "New input requires a fresh request after steering",
                    transport: "websocket",
                    operation: "request",
                    recovery: "rotate-and-retry-full",
                  }),
                })
              return { message: "", mode: "automatic" as const }
            }
            return {
              message: ProviderShared.encodeJson({
                ...fields,
                input: remaining,
                previous_response_id: previous.responseID,
              }),
              mode: "incremental" as const,
            }
          }),
        ),
      ),
    observe: (create, frame) =>
      Effect.gen(function* () {
        const event = yield* OpenResponses.decodeChannelEvent(frame).pipe(
          Effect.mapError((cause) =>
            ProviderShared.eventError(input.id, `Invalid ${input.name} WebSocket event`, frame, cause),
          ),
        )
        if (input.steering && event.type.startsWith("response.steer.")) {
          const identity = yield* decodeSteer(event.steer).pipe(
            Effect.mapError((cause) =>
              ProviderShared.eventError(input.id, "Invalid steering acknowledgement", frame, cause),
            ),
          )
          if (
            steer === undefined ||
            identity.previous_response_id !== responseID ||
            (event.type !== "response.steer.failed" && identity.id === undefined) ||
            (steerID !== undefined && identity.id !== steerID)
          )
            return yield* ProviderShared.eventError(
              input.id,
              "Steering acknowledgement does not match the active update",
              frame,
            )
          steerID = identity.id
          if (event.type === "response.steer.accepted") {
            accepted = true
            return { type: "ignore" }
          }
          if (event.type === "response.steer.failed") {
            if (ProviderShared.isRecord(event.error) && event.error.code === "steering_not_supported")
              unsupported.add(String(request.model))
            steer = undefined
            accepted = false
            return terminal ?? { type: "ignore" }
          }
          if (terminal && accepted && event.type === "response.steer.pending") return handoff(false)
          return { type: "ignore" }
        }
        if (terminal && accepted && event.type === "response.created") return handoff(true, frame)
        if (event.type === "response.created") responseID = event.response?.id
        const observation = yield* input.base.observeEvent
          ? input.base.observeEvent(create, frame, event)
          : input.base.observe(create, frame)
        if (event.type === "response.output_item.done" && event.item) output.push(event.item)
        if (observation.type === "provider-failure") {
          const rejection = code(event)
          if (rejection === "previous_response_not_found") return rejected(observation, "retry-full")
          if (rejection === "websocket_connection_limit_reached") return rejected(observation, "rotate-and-retry-full")
          // Only the continuation distinguishes an incremental send from a full one, so an unclassified
          // invalid request there is retried full; Codex reports a stale previous_response_id that way, with
          // no code. Classified failures such as context overflow keep their runner-owned recovery.
          if (
            create.mode === "incremental" &&
            observation.error.reason._tag === "InvalidRequest" &&
            observation.error.reason.classification === undefined
          )
            return rejected(observation, "retry-full")
        }
        if (observation.type !== "completed" && !(observation.type === "incomplete" && steer !== undefined))
          return observation
        if (
          steer !== undefined &&
          observation.type === "incomplete" &&
          event.response?.incomplete_details?.reason !== "steered"
        )
          return yield* new AIError({
            reason: new TransportError({
              message: "Steering parent ended without a steering continuation",
              transport: "websocket",
              operation: "read",
              recovery: "rotate-and-retry-full",
            }),
          })
        // A trigger installs a different context window. Clear the append baseline, retaining the socket.
        if (
          Array.isArray(request.input) &&
          request.input.some((item) => ProviderShared.isRecord(item) && item.type === "compaction_trigger")
        )
          return observation
        const finishedID = event.response?.id
        if (!finishedID || finishedID.trim().length === 0) return observation
        const completed = {
          ...observation,
          checkpoint: {
            protocol: PROTOCOL,
            value: {
              version: VERSION,
              responseID: finishedID,
              request,
              // Completion can re-encrypt reasoning. Callers replay the item already emitted by output_item.done.
              output: event.response?.output?.length
                ? event.response.output.map((item) =>
                    item.type === "reasoning" && item.id !== undefined
                      ? (output.find((done) => done.type === item.type && done.id === item.id) ?? item)
                      : item,
                  )
                : output.slice(),
            } satisfies CheckpointValue,
          },
        }
        terminal = completed
        if (steer !== undefined) return { type: "ignore" }
        return completed
      }),
  }
}

export * as OpenResponsesContinuation from "./open-responses-continuation.js"
