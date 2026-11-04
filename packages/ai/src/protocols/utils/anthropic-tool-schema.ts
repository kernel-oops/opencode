import type { JsonSchema } from "../../schema/index.js"
import { isRecord } from "../../utils/record.js"

// Anthropic forbids these applicators at the argument root. An always-true conditional
// applies the exact original constraints without flattening object-union branches.
export const anthropicToolSchema = (schema: JsonSchema, name: string): JsonSchema => {
  const combinators = ["allOf", "anyOf", "oneOf"]
  if (!combinators.some((key) => key in schema)) return schema
  const fail = (reason: string): never => {
    throw new Error(`Anthropic tool "${name}" schema cannot be projected safely: ${reason}`)
  }
  if (schema.type !== "object") fail('root combinators require type: "object"')
  if (
    typeof schema.$schema === "string" &&
    !/^https?:\/\/json-schema\.org\/(draft-07\/schema#?|draft\/2019-09\/schema#?|draft\/2020-12\/schema#?)$/.test(
      schema.$schema,
    )
  )
    fail(`dialect ${schema.$schema} does not establish support for if/then; use draft-07 or later`)
  const moved = [...combinators, "if", "then", "else"].filter((key) => key in schema)
  // References into relocated locations need scope-aware pointer rewriting. Until that
  // is available, reject explicitly rather than change what a reference resolves to.
  const inspect = (value: unknown): void => {
    if (!isRecord(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (["$ref", "$dynamicRef", "$recursiveRef"].includes(key) && typeof item === "string") {
        const fragment = item.slice(item.indexOf("#") + 1)
        const pointer = (() => {
          try {
            return decodeURIComponent(fragment).split("/")[1]
          } catch {
            return fail(`reference ${item} has an invalid URI fragment`)
          }
        })()
        if (item.includes("#") && moved.includes(pointer))
          fail(`reference ${item} targets a relocated root keyword; use a root $defs reference instead`)
      }
      // Only schema-valued keywords introduce schema nodes. const/enum/default/examples
      // are instance data, and names inside properties/$defs are not schema keywords.
      if (
        ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"].includes(key)
      ) {
        if (isRecord(item)) Object.values(item).forEach(inspect)
        continue
      }
      if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (Array.isArray(item)) item.forEach(inspect)
        continue
      }
      if (
        [
          "additionalProperties",
          "unevaluatedProperties",
          "additionalItems",
          "unevaluatedItems",
          "contains",
          "propertyNames",
          "not",
          "if",
          "then",
          "else",
          "contentSchema",
          "items",
        ].includes(key)
      ) {
        if (key === "items" && Array.isArray(item)) item.forEach(inspect)
        else inspect(item)
      }
    }
  }
  inspect(schema)
  const constraints = Object.fromEntries(Object.entries(schema).filter(([key]) => combinators.includes(key)))
  const conditional = Object.fromEntries(Object.entries(schema).filter(([key]) => ["if", "then", "else"].includes(key)))
  return {
    ...Object.fromEntries(Object.entries(schema).filter(([key]) => !moved.includes(key))),
    if: {},
    then: Object.keys(conditional).length ? { allOf: [constraints, conditional] } : constraints,
  }
}
