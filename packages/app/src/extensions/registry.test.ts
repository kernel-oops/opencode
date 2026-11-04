import { describe, expect, test } from "bun:test"
import { AppExtensions, extensionTabID, isExtensionTab } from "./registry"

describe("app extensions", () => {
  test("extension tab ids are recognisable", () => {
    expect(extensionTabID("background")).toBe("ext:background")
    expect(isExtensionTab("ext:background")).toBe(true)
    expect(isExtensionTab("context")).toBe(false)
    expect(isExtensionTab(undefined)).toBe(false)
  })

  test("registration is ordered, replaces by id and can be undone", () => {
    const first = AppExtensions.sessionHeaderItem({ id: "t-b", order: 2, render: () => null })
    const second = AppExtensions.sessionHeaderItem({ id: "t-a", order: 1, render: () => null })
    expect(
      AppExtensions.sessionHeaderItems()
        .map((item) => item.id)
        .filter((id) => id.startsWith("t-")),
    ).toEqual(["t-a", "t-b"])
    first()
    second()
    expect(AppExtensions.sessionHeaderItems().some((item) => item.id.startsWith("t-"))).toBe(false)
  })

  test("a failing busy check counts as not busy", () => {
    const off = AppExtensions.sessionBusy({
      id: "t-throws",
      busy: () => {
        throw new Error("boom")
      },
    })
    expect(AppExtensions.isBusy("ses_x", { session: { get: () => undefined } })).toBe(false)
    off()
  })
})
