import { LLM_LANGUAGE, NONCE_PATTERN } from "./plugin"
import type { SDKResponseLike, TextPartLike, TranslateState } from "./types"

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function unwrapData<T>(value: T | SDKResponseLike<T>): T {
  if (value && typeof value === "object" && "data" in value && (value as SDKResponseLike<T>).data !== undefined) {
    return (value as SDKResponseLike<T>).data as T
  }
  return value as T
}

export function isTranslateStateRecord(value: unknown): value is TranslateState {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.translate_enabled === true &&
    record.translate_llm_lang === LLM_LANGUAGE &&
    isNonEmptyString(record.translate_source_lang) &&
    isNonEmptyString(record.translate_display_lang) &&
    isNonEmptyString(record.translate_nonce) &&
    NONCE_PATTERN.test(record.translate_nonce)
  )
}

export function isTextPart(part: TextPartLike): part is TextPartLike & { text: string } {
  return part.type === "text" && typeof part.text === "string"
}

export function isUserAuthoredTextPart(part: TextPartLike): part is TextPartLike & { text: string } {
  return isTextPart(part) && part.synthetic !== true && part.ignored !== true
}
