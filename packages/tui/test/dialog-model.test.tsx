import { expect, test } from "bun:test"
import { DialogModel } from "../src/component/dialog-model"
import { model, renderLocal } from "./fixture/local"

test("the main picker hides deprecated aliases without removing explicit selections", async () => {
  const alias = { ...model("hidden-alias"), status: "deprecated" as const }
  await using setup = await renderLocal({ models: [model("visible-model"), alias] })
  setup.dialog.replace(() => <DialogModel providerID="provider" />)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("visible-model")
  expect(setup.captureCharFrame()).not.toContain("hidden-alias")
  setup.local.model.set({ providerID: "provider", modelID: "hidden-alias" })
  expect(setup.local.model.current()?.modelID).toBe("hidden-alias")
})
