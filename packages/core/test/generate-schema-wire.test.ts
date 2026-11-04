import { expect } from "bun:test"
import { LLMClient } from "@opencode/ai/effect"
import { AnthropicMessages, OpenAIResponses } from "@opencode/ai/protocols"
import { RequestExecutor } from "@opencode/ai/route"
import { Generate } from "@opencode/core/generate"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Model } from "@opencode/core/model"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const schema = {
  name: "permission_wire_v1",
  schema: {
    type: "object",
    properties: { outcome: { type: "string", enum: ["allow", "deny"] } },
    required: ["outcome"],
    additionalProperties: false,
  },
}
for (const transport of ["http", "websocket", "anthropic"] as const) {
  testEffect(Layer.empty).effect(`native schema survives ${transport} lowering without model policy changes`, () =>
    Effect.gen(function* () {
      const wire: Record<string, unknown>[] = []
      const bodies: Record<string, unknown>[] = []
      let calls = 0
      const events = () =>
        transport === "anthropic"
          ? [
              {
                type: "message_start",
                message: {
                  id: "msg",
                  role: "assistant",
                  content: [],
                  model: "api-model",
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"outcome":"allow"}' } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
              { type: "message_stop" },
            ]
          : [
              { type: "response.output_item.added", item: { type: "message", id: "message" } },
              { type: "response.output_text.delta", item_id: "message", delta: '{"outcome":"allow"}' },
              { type: "response.output_text.done", item_id: "message", text: '{"outcome":"allow"}' },
              {
                type: "response.completed",
                response: {
                  id: `resp_${calls}`,
                  status: "completed",
                  ...(calls === 1
                    ? {
                        output: [
                          {
                            type: "message",
                            id: "message",
                            content: [{ type: "refusal", refusal: '{"outcome":"allow"}' }],
                          },
                        ],
                      }
                    : {}),
                },
              },
            ]
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
            bodies.push(
              Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                yield* Effect.promise(() => web.json()),
              ),
            )
            expect(request.headers["x-route"]).toBe("retained")
            expect(request.headers["x-opencode-session"]).toStartWith("ses_")
            calls++
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                events()
                  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                  .join(""),
                {
                  headers: { "content-type": "text/event-stream" },
                },
              ),
            )
          }),
        ),
      )
      const native = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))
      const client = Layer.effect(
        LLMClient.Service,
        Effect.gen(function* () {
          const base = yield* LLMClient.Service
          return LLMClient.Service.of({
            ...base,
            generate: (request) =>
              base.generate(request, {
                webSocket: {
                  execute: (exchange) =>
                    transport !== "websocket"
                      ? Effect.succeed({ frames: exchange.fallback(), complete: Effect.void })
                      : Effect.gen(function* () {
                          const create = yield* exchange.driver.create(undefined)
                          wire.push(JSON.parse(create.message))
                          expect(exchange.connect.headers["x-route"]).toBe("retained")
                          expect(exchange.connect.headers["x-opencode-session"]).toStartWith("ses_")
                          calls++
                          return {
                            frames: Stream.fromIterable(events().map((event) => JSON.stringify(event))),
                            complete: Effect.void,
                          }
                        }),
                },
              }),
          })
        }),
      ).pipe(Layer.provide(native))
      const model =
        transport === "anthropic"
          ? AnthropicMessages.route.with({ http: { headers: { "x-route": "retained" } } }).model({ id: "api-model" })
          : OpenAIResponses.route.with({ http: { headers: { "x-route": "retained" } } }).model({
              id: "api-model",
              defaults: { providerOptions: { reasoningEffort: "low" } },
            })
      const defaults = JSON.stringify(model.route.defaults)
      const resolution = Layer.mock(ModelResolver.Service, {
        resolve: () =>
          Effect.succeed({
            model,
            ref: Model.Ref.parse("alias/configured-name"),
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
          }),
      })
      yield* Effect.gen(function* () {
        const generate = yield* Generate.Service
        const first = yield* generate
          .result({ prompt: "Exact harmless review", responseSchema: schema })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(first)).toBe(transport === "anthropic")
        const result = yield* generate.result({ prompt: "Exact harmless review", responseSchema: schema })
        expect(result.responseSchemaName).toBe(schema.name)
        expect(result.model).toEqual(Model.Ref.parse("alias/configured-name"))
        expect(result.text).toBe('{"outcome":"allow"}')
      }).pipe(Effect.provide(Generate.layer.pipe(Layer.provide(Layer.mergeAll(client, resolution, Layer.mock(Model.Service, {}), RequestExecutor.fetchLayer)))))
      const sent = transport === "websocket" ? wire : bodies
      expect(sent).toHaveLength(2)
      for (const body of sent) {
        expect(body.model).toBe("api-model")
        expect(body.tools).toBeUndefined()
        expect(body.max_output_tokens).toBeUndefined()
        if (transport === "anthropic")
          expect(body.output_config).toEqual({ format: { type: "json_schema", schema: schema.schema } })
        else {
          expect(body.text).toEqual({ format: { type: "json_schema", ...schema, strict: true } })
          expect(body.reasoning).toEqual({ effort: "low" })
          expect(body.input).toEqual([
            { type: "message", role: "user", content: [{ type: "input_text", text: "Exact harmless review" }] },
          ])
        }
      }
      expect(JSON.stringify(model.route.defaults)).toBe(defaults)
    }),
  )
}
