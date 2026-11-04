export * as BoundContent from "./content.js"

import path from "node:path"
import { MediaSniff } from "./media-sniff.js"

const BINARY_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])

/** Media the read tool would present natively rather than as text; never bound as text. */
export function isAttachmentContent(bytes: Uint8Array) {
  return MediaSniff.MEDIA_MIMES.has(MediaSniff.detect(bytes))
}

export function isBinaryContent(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}

export function isBinaryFile(filepath: string, bytes: Uint8Array) {
  if (BINARY_EXTENSIONS.has(path.extname(filepath).toLowerCase())) return true
  return isBinaryContent(bytes)
}
