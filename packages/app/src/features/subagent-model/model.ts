type Ref = { providerID: string; id: string; variant?: string }
type Catalogue = {
  models: readonly { providerID: string; id: string; name?: string }[]
  providers: readonly { id: string; name?: string }[]
}

const titlecase = (value: string) =>
  value.replace(/(^|[\s_-])(\w)/g, (_, gap: string, letter: string) => gap + letter.toUpperCase())

/** "Lister · GPT 6.1 Sol (OAuth) · OpenAI · high", from a subagent session and the model/provider catalogue. */
export function subagentModelLine(session: { agent?: string; model?: Ref }, catalogue: Catalogue) {
  const model = session.model
  if (!model) return undefined
  const info = catalogue.models.find((item) => item.providerID === model.providerID && item.id === model.id)
  const provider = catalogue.providers.find((item) => item.id === model.providerID)
  return [
    session.agent ? titlecase(session.agent) : "Subagent",
    info?.name ?? model.id,
    provider?.name ?? model.providerID,
    model.variant,
  ]
    .filter(Boolean)
    .join(" · ")
}
