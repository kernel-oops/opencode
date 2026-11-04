import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Generate } from "../src/generate.js"
import { Model } from "../src/model.js"

test("generation wire contract omits unknown categories and preserves explicit zeros", () => {
  const encode = Schema.encodeSync(Generate.Result)
  expect(encode({ text: "OK", usage: undefined, model: undefined })).toEqual({ text: "OK" })
  expect(
    encode({
      text: "OK",
      usage: { cacheReadInputTokens: 0, inputTokens: undefined },
      model: Model.Ref.parse("configured/model#variant"),
    }),
  ).toEqual({
    text: "OK",
    usage: { cacheReadInputTokens: 0 },
    model: { providerID: "configured", id: "model", variant: "variant" },
  })
  expect(Generate.Result.ast.annotations?.identifier).toBe("Generate.Result")
  expect(Generate.Usage.ast.annotations?.identifier).toBe("Generate.Usage")
})

test("normalised token categories reject malformed counts on decode and encode", () => {
  const categories = [
    "contextTokens",
    "inputTokens",
    "outputTokens",
    "nonCachedInputTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
    "reasoningTokens",
    "totalTokens",
  ]
  for (const category of categories) {
    for (const value of [-1, 1.5, NaN, Infinity, -Infinity]) {
      expect(() => Schema.decodeUnknownSync(Generate.Usage)({ [category]: value })).toThrow()
      expect(() => Schema.encodeSync(Generate.Usage)({ [category]: value })).toThrow()
    }
    expect(Schema.decodeUnknownSync(Generate.Usage)({ [category]: 0 })).toEqual({ [category]: 0 })
  }
})
