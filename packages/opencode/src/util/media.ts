import path from "node:path"

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

const READ_IMAGE_ATTACHMENT_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

export function isReadAttachmentMime(mime: string) {
  return READ_IMAGE_ATTACHMENT_MIMES.has(mime) || isPdfAttachment(mime)
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}

export function isBinaryFile(filepath: string, bytes: Uint8Array) {
  const ext = path.extname(filepath).toLowerCase()
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
  }

  if (bytes.length === 0) return false

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) nonPrintableCount++
  }
  return nonPrintableCount / bytes.length > 0.3
}
