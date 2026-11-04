// The targeted offline gate may use fake loopback servers, never the live central server.
const original = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    if (url.port === "4396") return Promise.reject(new Error("Isolated new_session tests prohibit central port 4396"))
    return original(input, init)
  },
  { preconnect: original.preconnect },
)
