export * as MediaSniff from "./media-sniff.js"

/**
 * Intentional duplicate of `@opencode/core`'s `mime.ts` byte-sniffer and `read-filesystem.ts`'s
 * `MEDIA_MIMES` set. `@opencode/util` cannot depend on `@opencode/core` (the reverse is true:
 * core depends on util), and this file's only consumer, `content.ts`, is here specifically so it
 * can be imported from core without pulling core back in. Magic-number byte sniffing is stable;
 * keep this in sync with core's copy by hand if either changes.
 */

export const MEDIA_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

export function detect(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  if (
    startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]) &&
    (startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x66]) || startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x73]))
  )
    return "image/avif"
  return isText(bytes) ? "text/plain" : "application/octet-stream"
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  return controls / bytes.length <= 0.3
}
