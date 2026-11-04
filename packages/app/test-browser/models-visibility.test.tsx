import { afterEach, expect, mock, setSystemTime, test } from "bun:test"
import { createComponent, createContext, createRoot, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"

const date = "2026-10-01"
const providers = ["openai", "other"].map((id) => ({
  id,
  models: Object.fromEntries([
    ["sol", { id: "sol", name: "Sol", family: "sol", release_date: date }],
    ["sol-fast", { id: "sol-fast", name: "Sol Fast", family: "sol", release_date: date }],
    ["sol-old", { id: "sol-old", name: "Old Sol", family: "sol", release_date: "2026-09-01" }],
    ["undated", { id: "undated", name: "Undated", family: "other", release_date: "unknown" }],
  ]),
}))
const [store, set] = createStore({
  user: [] as { providerID: string; modelID: string; visibility: "show" | "hide" }[],
  recent: [],
  variant: {} as Record<string, string>,
})
mock.module("@/providers/catalog/providers", () => ({ useProviders: () => ({ connected: () => providers }) }))
mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ models: { store, set, ready: () => true, recent: () => [] } }) }))
// Use Solid's actual context without importing the UI package's precompiled JSX boundary.
mock.module("@opencode/ui/context", () => ({
  createSimpleContext<T, P extends object>(input: { init: (props: P) => T }) {
    const context = createContext<T>()
    return {
      use: () => useContext(context),
      provider: (props: ParentProps<P>) => createComponent(context.Provider, {
        value: input.init(props),
        get children() { return props.children },
      }),
    }
  },
}))
const { ModelsProvider, useModels } = await import("@/providers/models/models")

afterEach(() => {
  set("user", [])
  setSystemTime()
})

test("same-release alternatives remain visible by default without exposing older family releases", () => {
  setSystemTime(new Date("2026-10-17T12:00:00Z"))
  createRoot((dispose) => {
    createComponent(ModelsProvider, {
      get children() {
        const models = useModels()
        for (const providerID of ["openai", "other"]) {
          expect(models.visible({ providerID, modelID: "sol" })).toBe(true)
          expect(models.visible({ providerID, modelID: "sol-fast" })).toBe(true)
          expect(models.visible({ providerID, modelID: "sol-old" })).toBe(false)
          expect(models.visible({ providerID, modelID: "undated" })).toBe(true)
        }
        return null
      },
    })
    dispose()
  })
})

test("explicit user visibility still wins over same-release default visibility", () => {
  setSystemTime(new Date("2026-10-17T12:00:00Z"))
  createRoot((dispose) => {
    createComponent(ModelsProvider, {
      get children() {
        const models = useModels()
        models.setVisibility({ providerID: "openai", modelID: "sol-fast" }, false)
        models.setVisibility({ providerID: "openai", modelID: "sol-old" }, true)
        expect(models.visible({ providerID: "openai", modelID: "sol-fast" })).toBe(false)
        expect(models.visible({ providerID: "other", modelID: "sol-fast" })).toBe(true)
        expect(models.visible({ providerID: "openai", modelID: "sol-old" })).toBe(true)
        return null
      },
    })
    dispose()
  })
})
