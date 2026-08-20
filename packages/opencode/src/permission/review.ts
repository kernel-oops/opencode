import type { PermissionReviewValue } from "@opencode-ai/plugin"
import { types } from "node:util"

const MAX_DEPTH = 8
const MAX_ITEMS = 50
const MAX_NODES = 1_000
const MAX_STRING_LENGTH = 1_024
const MAX_KEY_LENGTH = 128
const REDACTED = "[REDACTED]"
const TRUNCATED = "[TRUNCATED]"

const privateKey = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g
const authHeader = /\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi
const sensitiveHeader =
  /'(Proxy-Authorization|Authorization|Set-Cookie|Cookie)\s*:\s*(?:\\.|[^'\\\r\n])*'|"(Proxy-Authorization|Authorization|Set-Cookie|Cookie)\s*:\s*(?:\\.|[^"\\\r\n])*"|\b(Proxy-Authorization|Authorization|Set-Cookie|Cookie)\s*:\s*[^\r\n]*/gi
const jsonAssignment = /"([^"\\]+)"(\s*:\s*)(?:"(?:\\.|[^"\\])*"|'[^'\r\n]*'|[^\s,;&}]+)/g
const optionAssignment = /(--?([A-Za-z][\w-]*)(?:=|\s+))(?:(?:"[^"\r\n]*")|(?:'[^'\r\n]*')|[^\s,;&]+)/g
const plainAssignment = /\b([A-Za-z_][\w.-]*)(\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/g

function isSecretKey(key: string) {
  const value = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
  return /(password|passphrase|secret|token|apikey|authorization|cookie|privatekey|credential|accesskey(?:id)?|sessionkey|sessiontoken|securitytoken|clientsecret|accountkey|storagekey|connectionstring|saskey|sastoken)s?$/.test(
    value,
  )
}

function redactString(value: string) {
  const redacted = value
    .replace(privateKey, REDACTED)
    .replace(authHeader, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(jsonAssignment, (match, key: string, separator: string) =>
      isSecretKey(key) ? `"${key}"${separator}"${REDACTED}"` : match,
    )
    .replace(optionAssignment, (match, option: string, key: string) =>
      isSecretKey(key) ? `${option}${REDACTED}` : match,
    )
    .replace(plainAssignment, (match, key: string, separator: string) =>
      isSecretKey(key) ? `${key}${separator}${REDACTED}` : match,
    )
    .replace(sensitiveHeader, (_match, single: string | undefined, double: string | undefined, plain: string) => {
      const name = single ?? double ?? plain
      if (single) return `'${name}: ${REDACTED}'`
      if (double) return `"${name}: ${REDACTED}"`
      return `${name}: ${REDACTED}`
    })
    .replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, `://${REDACTED}@`)
  if (redacted.length <= MAX_STRING_LENGTH) return redacted
  return redacted.slice(0, MAX_STRING_LENGTH) + TRUNCATED
}

function safeKey(key: string, index: number) {
  if (key.length > MAX_KEY_LENGTH) return `[LONG_KEY_${index}]`
  if (key === "__proto__" || key === "constructor" || key === "prototype") return `[UNSAFE_KEY_${index}]`
  return key.replace(/[\u0000-\u001f\u007f]/g, "�")
}

/**
 * Converts trusted JSON-like tool input into a deterministic, bounded value for permission review.
 * Accessors are never invoked and obvious secret-bearing values are redacted. Proxies are rejected
 * before inspection because arbitrary proxy traps cannot otherwise be made side-effect-free.
 */
export function safeReviewValue(input: unknown): PermissionReviewValue {
  const ancestors = new WeakSet<object>()
  let nodes = 0

  const visit = (value: unknown, depth: number): PermissionReviewValue => {
    nodes++
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return TRUNCATED
    if (value === null) return null
    if (typeof value === "string") return redactString(value)
    if (typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value : `[UNSUPPORTED:${String(value)}]`
    if (typeof value !== "object") return `[UNSUPPORTED:${typeof value}]`
    if (types.isProxy(value)) return "[UNSUPPORTED:proxy]"
    if (ancestors.has(value)) return "[CIRCULAR]"

    const prototype = Object.getPrototypeOf(value)
    const array = Array.isArray(value)
    if (array && prototype !== Array.prototype) return "[UNSUPPORTED:object]"
    if (!array && prototype !== Object.prototype && prototype !== null) return "[UNSUPPORTED:object]"

    ancestors.add(value)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (array) {
        const length = descriptors.length?.value
        if (!Number.isSafeInteger(length) || length < 0) return "[UNSUPPORTED:array]"
        const result: PermissionReviewValue[] = []
        const count = Math.min(length, MAX_ITEMS)
        for (let index = 0; index < count; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor) result.push("[EMPTY]")
          else if (!("value" in descriptor)) result.push("[ACCESSOR]")
          else result.push(visit(descriptor.value, depth + 1))
        }
        if (length > MAX_ITEMS) result.push(`${TRUNCATED} ${length - MAX_ITEMS} item(s)`)
        return result
      }

      const result: Record<string, PermissionReviewValue> = Object.create(null)
      const keys = Object.keys(descriptors)
        .filter((key) => descriptors[key]?.enumerable)
        .sort()
      for (const [index, key] of keys.slice(0, MAX_ITEMS).entries()) {
        const descriptor = descriptors[key]
        if (!descriptor) continue
        const baseKey = safeKey(key, index)
        let outputKey = baseKey
        let collision = 0
        while (Object.hasOwn(result, outputKey)) {
          const suffix = `#${++collision}`
          outputKey = baseKey.slice(0, MAX_KEY_LENGTH - suffix.length) + suffix
        }
        if (!("value" in descriptor)) result[outputKey] = "[ACCESSOR]"
        else if (outputKey.startsWith("[LONG_KEY_") || outputKey.startsWith("[UNSAFE_KEY_") || isSecretKey(key))
          result[outputKey] = REDACTED
        else result[outputKey] = visit(descriptor.value, depth + 1)
      }
      if (keys.length > MAX_ITEMS) result[TRUNCATED] = `${keys.length - MAX_ITEMS} key(s)`
      return result
    } catch {
      return "[UNREADABLE]"
    } finally {
      ancestors.delete(value)
    }
  }

  return visit(input, 0)
}
