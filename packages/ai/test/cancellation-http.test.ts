import { expect } from "bun:test"
import { createServer } from "node:http"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { ai, LLMClient } from "../src/effect.js"
import { OpenAI } from "../src/providers.js"
import { testEffect } from "./lib/effect.js"
import { runtimeLayer } from "./lib/http.js"

testEffect(runtimeLayer(FetchHttpClient.layer)).live("cancelling HTTP model consumption closes the old response and allows a fresh request", () =>
  Effect.gen(function* () {
    const received = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    let requests = 0
    const server = yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<ReturnType<typeof createServer>>((resolve) => {
        const server = createServer((_request, response) => {
          requests++
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(`data: ${JSON.stringify({ id: `response-${requests}`, choices: [{ index: 0, delta: { role: "assistant", content: requests === 1 ? "Partial" : "Fresh" }, finish_reason: null }] })}\n\n`)
          if (requests === 1) {
            response.once("close", () => Deferred.doneUnsafe(cancelled, Effect.void))
            Deferred.doneUnsafe(received, Effect.void)
            return
          }
          response.end(`data: ${JSON.stringify({ id: "response-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
        })
        server.listen(0, "127.0.0.1", () => resolve(server))
      })),
      (server) => Effect.promise(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })),
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("HTTP fixture has no address")
    const model = OpenAI.configure({ apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}/v1` }).chat("fixture")
    const first = yield* LLMClient.stream(ai.request({ model, prompt: "Original" })).pipe(Stream.runDrain, Effect.forkChild)
    yield* Deferred.await(received)
    yield* Fiber.interrupt(first)
    yield* Deferred.await(cancelled)
    const fresh = yield* LLMClient.generate(ai.request({ model, prompt: "Correction" }))
    expect(fresh.text).toBe("Fresh")
    expect(requests).toBe(2)
  }),
)
