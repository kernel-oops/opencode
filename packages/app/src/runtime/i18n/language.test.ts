import { describe, expect, test } from "bun:test"
import { pluralCategory, resolveTemplate } from "@opencode/ui/context/i18n"
import en from "./en"
import { backgroundSummaryText, localizedListParts, richTemplateParts } from "./language"

describe("rich translations", () => {
  test("lets the translated phrase position a rich slot", () => {
    const names = { type: "names" }
    expect(richTemplateParts("Written by {{names}}", { names })).toEqual(["Written by ", names])
    expect(richTemplateParts("{{names}} tarafından yazıldı", { names })).toEqual([names, " tarafından yazıldı"])
  })

  test("keeps list elements intact while localizing punctuation", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }]
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the check is that no element was stringified
    expect(localizedListParts("en", items).filter((part) => typeof part !== "string")).toEqual(items)
  })
})

describe("background summary", () => {
  const source: Record<string, string> = en

  const plural = (key: string, count: number) =>
    resolveTemplate(source[`${key}.${pluralCategory("en", count)}`], { count })

  const none = { running: 0, completed: 0, error: 0, cancelled: 0, idle: 0 }

  test("lists each non-zero status count with its plural phrase", () => {
    expect(backgroundSummaryText("en", { ...none, running: 2, completed: 1 }, plural)).toBe(
      "2 subagents running, 1 completed",
    )
    expect(backgroundSummaryText("en", { ...none, completed: 1, error: 1, cancelled: 1 }, plural)).toBe(
      "1 completed, 1 failed, 1 cancelled",
    )
    expect(backgroundSummaryText("en", none, plural)).toBe("")
  })
})
