export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * A short, stable, opaque code for diagnostics. Never contains child text:
 * used for event-log entries so exports stay inside the documented bounded
 * event schema regardless of suggestion length.
 */
export function opaqueCode(input: string): string {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0
  }
  return `e${(hash >>> 0).toString(36)}`
}
