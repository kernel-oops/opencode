import { ConfigPermissionReviewerV1 } from "@opencode-ai/core/v1/config/permission-reviewer"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { buildPermissionReviewSnapshot, serialiseReviewInput } from "./reviewer-input"
import {
  CAPACITY,
  REVIEW_MODEL_ID,
  streamPermissionAssessment,
  type Assessment,
  type AssessmentResult,
  type Decision,
  type Failure,
  type Review,
} from "./reviewer-assessment"

const REVIEW_TIMEOUT = "30 seconds"
export { CAPACITY, type Assessment, type AssessmentResult, type Decision, type Failure, type Review }
export { isAdvisoryAllowCandidate } from "./advisory-gate"
export type Result = { decision: Decision } | { failure: Failure }

export interface Input {
  config: ConfigPermissionReviewerV1.Info
  permission: string
  origin: string
  snapshot?: import("@opencode-ai/plugin").PermissionReviewSnapshot
  arguments?: unknown
  cwd?: string
  timeoutMs?: number
}

export interface Run {
  readonly admitted: boolean
  readonly result: Effect.Effect<Result>
  readonly settled: Effect.Effect<void>
  readonly abort: () => void
  readonly isSettled: () => boolean
}

export interface AssessmentRun {
  readonly admitted: boolean
  readonly result: Effect.Effect<AssessmentResult>
  readonly settled: Effect.Effect<void>
  readonly abort: () => void
  readonly isSettled: () => boolean
}

export interface Interface {
  readonly prepareAssessment: (input: Input) => Effect.Effect<AssessmentRun>
  readonly assess: (input: Input) => Effect.Effect<AssessmentResult>
  readonly prepare: (input: Input) => Effect.Effect<Run>
  readonly review: (input: Input) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionReviewer") {}

interface Operation {
  readonly controller: AbortController
  settled: boolean
}

// This set deliberately outlives instance and service scopes. A provider Promise that ignores
// cancellation remains globally accounted for until the native operation actually settles.
const operations = new Set<Operation>()

function interruptOr<T>(exit: Exit.Exit<T, unknown>, fallback: Failure): Effect.Effect<T | { failure: Failure }> {
  if (Exit.isSuccess(exit)) return Effect.succeed(exit.value)
  if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause as Cause.Cause<never>)
  return Effect.succeed({ failure: fallback })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const owned = new Set<Operation>()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const operation of owned) operation.controller.abort()
        owned.clear()
      }),
    )

    const prepareAssessment: Interface["prepareAssessment"] = Effect.fn("PermissionReviewer.prepareAssessment")(
      function* (input) {
        const snapshot =
          input.snapshot ??
          buildPermissionReviewSnapshot({
            permission: input.permission,
            origin: input.origin,
            patterns: [],
            metadata: {},
            action: {
              identity: input.permission,
              arguments: input.arguments,
              ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
              complete: false,
            },
            trusted: [],
            untrusted: [],
            trustedComplete: false,
            untrustedComplete: false,
            contextSafeForGate: false,
          })
        const serialised = serialiseReviewInput({ snapshot })
        if (!("data" in serialised)) {
          return {
            admitted: false,
            result: Effect.succeed(serialised),
            settled: Effect.void,
            abort: () => {},
            isSettled: () => true,
          }
        }
        if (operations.size >= CAPACITY) {
          return {
            admitted: false,
            result: Effect.succeed({ failure: "capacity" as const }),
            settled: Effect.void,
            abort: () => {},
            isSettled: () => true,
          }
        }

        const controller = new AbortController()
        const operation: Operation = { controller, settled: false }
        operations.add(operation)
        owned.add(operation)
        const execute: Effect.Effect<AssessmentResult> = Effect.gen(function* () {
          const parsed = Provider.parseModel(input.config.model)
          if (!parsed.providerID || !parsed.modelID) return { failure: "model_config" as const }
          const modelResult = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(Effect.exit)
          const model = yield* interruptOr(modelResult, "model_lookup")
          if ("failure" in model) return model
          if (controller.signal.aborted) return { failure: "timeout" as const }
          if (model.api.id !== REVIEW_MODEL_ID) return { failure: "model_identity" as const }

          const languageResult = yield* provider.getLanguage(model).pipe(Effect.exit)
          const language = yield* interruptOr(languageResult, "provider")
          if ("failure" in language) return language
          if (controller.signal.aborted) return { failure: "timeout" as const }

          const authResult = yield* auth.get(model.providerID).pipe(Effect.exit)
          const authInfo = yield* interruptOr(authResult, "auth")
          if (authInfo && "failure" in authInfo) return authInfo
          if (controller.signal.aborted) return { failure: "timeout" as const }
          const openaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"
          return yield* Effect.promise(() =>
            streamPermissionAssessment({
              model: language,
              serialised: serialised.data,
              abortSignal: controller.signal,
              abort: () => controller.abort(),
              openaiOauth,
              openaiProvider: model.providerID === "openai",
              temperature: model.capabilities.temperature ? 0 : undefined,
            }),
          )
        })

        // A daemon fibre inherits the caller's instance references but is not interrupted
        // when an individual permission waiter goes away. Its completion remains the
        // actual-settlement witness for capacity accounting; cancellation is requested
        // separately through the provider's AbortSignal.
        const fibre = yield* execute.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              operation.settled = true
              operations.delete(operation)
              owned.delete(operation)
            }),
          ),
          Effect.forkDetach({ startImmediately: true }),
        )
        const joined = Fiber.await(fibre).pipe(
          Effect.flatMap((exit) => (Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))),
        )

        const result = joined.pipe(
          Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
          Effect.timeoutOrElse({
            duration: input.timeoutMs ?? REVIEW_TIMEOUT,
            orElse: () => Effect.sync(() => controller.abort()).pipe(Effect.as({ failure: "timeout" as const })),
          }),
        )

        return {
          admitted: true,
          result,
          settled: Fiber.await(fibre).pipe(Effect.asVoid),
          abort: () => controller.abort(),
          isSettled: () => operation.settled,
        }
      },
    )

    const prepare: Interface["prepare"] = Effect.fn("PermissionReviewer.prepare")(function* (input) {
      const run = yield* prepareAssessment(input)
      return {
        ...run,
        result: run.result.pipe(
          Effect.map((result): Result => {
            if ("failure" in result) return result
            if (result.assessment.outcome === "allow" && (input.config.automatic_allow ?? "never") === "never")
              return { decision: "ask" }
            return { decision: result.assessment.outcome }
          }),
        ),
      }
    })

    const assess: Interface["assess"] = Effect.fn("PermissionReviewer.assess")(function* (input) {
      const run = yield* prepareAssessment(input)
      return yield* run.result
    })

    const review: Interface["review"] = Effect.fn("PermissionReviewer.review")(function* (input) {
      const run = yield* prepare(input)
      return yield* run.result
    })

    return Service.of({ prepareAssessment, assess, prepare, review })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Provider.node, Auth.node] })

export * as PermissionReviewer from "./reviewer"
