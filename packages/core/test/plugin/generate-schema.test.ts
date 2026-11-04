import { expect } from "bun:test"
import { Generate } from "@opencode/core/generate"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Effect, Layer, Schema } from "effect"
import { Generate as GenerateSchema } from "@opencode/schema/generate"
import { testEffect } from "../lib/effect"
import { makePluginTestLayer } from "./fixture"

const inputs: Generate.TextInput[] = []
const generate = Layer.succeed(
  Generate.Service,
  Generate.Service.of({
    image: () => Effect.die("unused"),
    decisions: () => Effect.die("unused"),
    text: () => Effect.die("The host must retain Core's acknowledged result"),
    result: (input) =>
      Effect.sync(() => {
        inputs.push(input)
        return { text: "{}", ...(input.responseSchema ? { responseSchemaName: input.responseSchema.name } : {}) }
      }),
  }),
)
const it = testEffect(makePluginTestLayer(undefined, generate))

it.live("native schema request and acknowledgement survive the Effect host and Promise codecs", () =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service)
    yield* PluginPromise.fromPromise({
      id: "schema-receipt",
      async setup(context) {
        const responseSchema = { name: "permission_test_v1", schema: { type: "object" } }
        expect(await context.generate.text({ prompt: "Review", responseSchema })).toEqual({
          text: "{}",
          responseSchemaName: responseSchema.name,
        })
        expect(inputs.at(-1)).toEqual({ prompt: "Review", responseSchema })
        expect(await context.generate.text({ prompt: "Text only" })).toEqual({ text: "{}" })
        for (const name of ["", "a".repeat(65), "bad.name", "space name"])
          expect(
            await context.generate.text({ prompt: "Review", responseSchema: { ...responseSchema, name } }).then(
              () => false,
              () => true,
            ),
          ).toBe(true)
      },
    }).effect(host)
    expect(Schema.encodeSync(GenerateSchema.Result)({ text: "{}", responseSchemaName: "exact" })).toEqual({
      text: "{}",
      responseSchemaName: "exact",
    })
    expect(Schema.encodeSync(GenerateSchema.Result)({ text: "{}", responseSchemaName: undefined })).toEqual({
      text: "{}",
    })
  }),
)
