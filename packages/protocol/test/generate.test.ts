import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Generate } from "@opencode/schema/generate"
import { Model } from "@opencode/schema/model"
import { GenerateGroup } from "../src/groups/generate.js"

test("stateless generation keeps its route and additive response contract", () => {
  const endpoint = GenerateGroup.endpoints["generate.text"]
  expect(endpoint.method).toBe("POST")
  expect(endpoint.path).toBe("/api/experimental/generate/text")
  expect(GenerateGroup.endpoints["generate.textLegacy"].path).toBe("/api/experimental/generate")
  const success = Array.from(endpoint.success)[0]!
  if (success.ast._tag !== "Objects") throw new Error("Expected a structured generation response")
  expect(success.ast.propertySignatures[0]?.type.annotations?.identifier).toBe("Generate.Result")
  const decode = Schema.decodeUnknownSync(Schema.Struct({ data: Generate.Result }))
  expect(decode({ data: { text: "OK" } })).toEqual({ data: { text: "OK" } })
  expect(
    decode({
      data: { text: "OK", usage: { cacheReadInputTokens: 0 }, model: { providerID: "configured", id: "model" } },
    }),
  ).toEqual({
    data: {
      text: "OK",
      usage: { cacheReadInputTokens: 0 },
      model: Model.Ref.parse("configured/model"),
    },
  })
})
