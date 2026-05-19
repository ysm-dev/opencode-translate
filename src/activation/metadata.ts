import {
  isTextPart,
  isTranslateStateRecord,
  LLM_LANGUAGE,
  type StoredTextMetadata,
  type TextPartLike,
  type TranslateState,
} from "../constants"
import { hashText } from "../translator"

export function asMetadata(part: TextPartLike): StoredTextMetadata {
  return (part.metadata ?? {}) as StoredTextMetadata
}

export function extractStateFromMetadata(metadata: StoredTextMetadata | undefined): TranslateState | undefined {
  if (!isTranslateStateRecord(metadata)) return undefined
  return {
    translate_enabled: true,
    translate_user_lang: metadata.translate_user_lang,
    translate_llm_lang: LLM_LANGUAGE,
    translate_nonce: metadata.translate_nonce,
  }
}

export function mergeTranslatedMetadata(
  state: TranslateState,
  part: TextPartLike,
  english: string,
): Record<string, unknown> {
  return {
    ...(part.metadata ?? {}),
    ...state,
    translate_source_hash: hashText(part.text ?? ""),
    translate_en: english,
  }
}

export function isTranslatedUserDisplayPart(part: TextPartLike): boolean {
  if (!isTextPart(part) || part.synthetic === true) return false
  return extractStateFromMetadata(asMetadata(part)) !== undefined
}
