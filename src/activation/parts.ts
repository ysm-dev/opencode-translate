import {
  parseTranslatorModel,
  type ResolvedTranslateOptions,
  SPEC_VERSION,
  type TextPartLike,
  type TranslateState,
} from "../constants"
import { createSyntheticPartID } from "../translator"

export function createActivationBannerText(options: ResolvedTranslateOptions): string {
  const { modelID } = parseTranslatorModel(options.translatorModel)
  return `✓ Translation mode enabled · translator: ${modelID} · language: ${options.lang}`
}

export function createLlmOnlyTextPart(
  sessionID: string,
  messageID: string,
  text: string,
  metadata: Record<string, unknown>,
): TextPartLike {
  return {
    id: createSyntheticPartID(),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: true,
    ignored: false,
    metadata,
  }
}

export function createActivationBannerPart(
  sessionID: string,
  messageID: string,
  state: TranslateState,
  text: string,
): TextPartLike {
  return {
    id: createSyntheticPartID(),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: true,
    ignored: true,
    metadata: {
      ...state,
      translate_role: "activation_banner",
      translate_spec_version: SPEC_VERSION,
    },
  }
}
