import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ai } from "../src/effect.js"
import { AnthropicMessages, OpenAIResponses } from "../src/protocols.js"
import { anthropicToolSchema } from "../src/protocols/utils/anthropic-tool-schema.js"
import { compileRequest } from "../src/route/client.js"
import { it } from "./lib/effect.js"

describe("Anthropic argument root projection", () => {
  test("does not interpret instance data or property names as schema references", () => {
    const literal = { $ref: "#/anyOf/0", $dynamicRef: "#/then", $recursiveRef: "#/%ZZ" }
    const schema = {
      type: "object",
      anyOf: [{ required: ["a"] }, { required: ["b"] }],
      properties: {
        a: { const: literal, enum: [literal], default: literal, examples: [literal] },
        $ref: { const: "#/anyOf/0" },
      },
      $defs: { $ref: { type: "string" } },
    }
    const projected = anthropicToolSchema(schema, "literal")
    expect(projected.properties).toBe(schema.properties)
    expect(projected.$defs).toBe(schema.$defs)
    expect(projected.then).toEqual({ anyOf: schema.anyOf })
  })
  test("keeps simultaneous applicators, conditionals, annotations and reference scope", () => {
    const schema = {
      type: "object",
      $id: "https://fixture.invalid/tool",
      $defs: { value: { type: "string" } },
      description: "fixture",
      required: ["operation"],
      unevaluatedProperties: false,
      allOf: [{ properties: { operation: { $ref: "#/$defs/value" } } }],
      anyOf: [{ required: ["a"] }, { required: ["b"] }],
      oneOf: [{ required: ["a"] }, { required: ["b"] }],
      if: { required: ["a"] },
      then: { required: ["c"] },
      else: { required: ["d"] },
    }
    const original = JSON.stringify(schema)
    expect(anthropicToolSchema(schema, "fixture")).toEqual({
      type: schema.type,
      $id: schema.$id,
      $defs: schema.$defs,
      description: schema.description,
      required: schema.required,
      unevaluatedProperties: false,
      if: {},
      then: {
        allOf: [
          { allOf: schema.allOf, anyOf: schema.anyOf, oneOf: schema.oneOf },
          { if: schema.if, then: schema.then, else: schema.else },
        ],
      },
    })
    expect(JSON.stringify(schema)).toBe(original)
  })

  test("leaves nested unions and recursive root definitions alone", () => {
    const schema = {
      type: "object",
      $defs: { node: { properties: { child: { $ref: "#/$defs/node" } } } },
      properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
    }
    expect(anthropicToolSchema(schema, "nested")).toBe(schema)
  })

  test("fails closed with the tool name for moved-path references and non-object roots", () => {
    for (const ref of ["#/anyOf/0", "https://fixture.invalid/tool#/then/properties/a", "#/%6fneOf/0"])
      expect(() =>
        anthropicToolSchema({ type: "object", anyOf: [{}], oneOf: [{}], then: {}, $ref: ref }, "fixture"),
      ).toThrow('Anthropic tool "fixture" schema cannot be projected safely: reference')
    expect(() => anthropicToolSchema({ type: "string", anyOf: [{}] }, "text")).toThrow('tool "text"')
    expect(() => anthropicToolSchema({ type: "object", anyOf: [{}], $ref: "#/%ZZ" }, "bad-ref")).toThrow(
      'tool "bad-ref"',
    )
    expect(() =>
      anthropicToolSchema(
        { type: "object", anyOf: [{}], $schema: "http://json-schema.org/draft-04/schema#" },
        "old-draft",
      ),
    ).toThrow("does not establish support for if/then")
  })

  it.effect("compiles native and namespaced MCP/task declarations only for Anthropic", () =>
    Effect.gen(function* () {
      const union = {
        type: "object",
        anyOf: [
          {
            type: "object",
            properties: { operation: { const: "status" }, key: { type: "string" } },
            required: ["operation", "key"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { operation: { const: "close" }, evidence: { type: "string" } },
            required: ["operation", "evidence"],
            additionalProperties: false,
          },
        ],
      }
      const tools = [
        { name: "new_session", description: "Native fixture", inputSchema: union },
        {
          name: "subagent",
          description: "Task fixture",
          inputSchema: { type: "object", properties: { agent: { type: "string" } } },
        },
        {
          type: "namespace" as const,
          name: "mcp",
          description: "MCP fixture",
          tools: [{ name: "lookup", description: "MCP union", inputSchema: union }],
        },
      ]
      const original = JSON.stringify(tools)
      const anthropic = yield* compileRequest(
        ai.request({
          model: AnthropicMessages.route.model({ id: "fixture" }),
          prompt: "Fixture",
          tools,
          toolChoice: "none",
          cache: "none",
        }),
      )
      expect(anthropic.body.tools?.map((tool) => tool.name)).toEqual(["new_session", "subagent", "mcp_lookup"])
      expect(anthropic.body.tools?.map((tool) => tool.description)).toEqual([
        "Native fixture",
        "Task fixture",
        "MCP union",
      ])
      for (const tool of anthropic.body.tools ?? []) {
        expect(tool.input_schema.type).toBe("object")
        for (const key of ["anyOf", "oneOf", "allOf"]) expect(tool.input_schema[key]).toBeUndefined()
      }
      const openai = yield* compileRequest(
        ai.request({
          model: OpenAIResponses.route.model({ id: "fixture" }),
          prompt: "Fixture",
          tools,
          cache: "none",
        }),
      )
      expect(JSON.stringify(openai.body.tools?.[0]?.parameters)).toBe(JSON.stringify(union))
      expect(JSON.stringify(tools)).toBe(original)
    }),
  )
})
