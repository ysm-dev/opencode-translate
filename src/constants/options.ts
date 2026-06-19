import { AUTH_ENV_FALLBACK, DEFAULT_TRIGGER, PLUGIN_NAME } from "./plugin"
import type { AssistantTranslationMode, ProviderInfo, ResolvedTranslateOptions } from "./types"

const ASSISTANT_TRANSLATION_MODES = new Set<AssistantTranslationMode>(["each-part", "final-message"])

function resolveAssistantTranslationMode(value: unknown): AssistantTranslationMode {
  if (value === undefined) return "final-message"
  if (typeof value === "string" && ASSISTANT_TRANSLATION_MODES.has(value as AssistantTranslationMode)) {
    return value as AssistantTranslationMode
  }
  throw new Error(
    `[${PLUGIN_NAME}:INVALID_OPTIONS] options.assistantTranslation must be "each-part" or "final-message".`,
  )
}

export function resolveOptions(options: Record<string, unknown>): ResolvedTranslateOptions {
  const model = typeof options.model === "string" ? options.model.trim() : ""
  if (!model) {
    throw new Error(
      `[${PLUGIN_NAME}:INVALID_OPTIONS] options.model is required. Set it to the translator model, e.g. "anthropic/claude-haiku-4-5".`,
    )
  }
  const slash = model.indexOf("/")
  if (slash < 1 || slash === model.length - 1) {
    throw new Error(
      `[${PLUGIN_NAME}:INVALID_OPTIONS] options.model must be in provider/model-id form, e.g. "anthropic/claude-haiku-4-5".`,
    )
  }

  const lang = typeof options.lang === "string" ? options.lang.trim() : ""
  if (!lang) {
    throw new Error(
      `[${PLUGIN_NAME}:INVALID_OPTIONS] options.lang is required. Set it to the user's language, e.g. "Korean" or "Japanese".`,
    )
  }
  const variant = typeof options.variant === "string" ? options.variant.trim() : ""

  const rawTrigger = Array.isArray(options.trigger)
    ? options.trigger
    : Array.isArray(options.triggerKeywords)
      ? options.triggerKeywords
      : DEFAULT_TRIGGER
  const trigger = rawTrigger.filter((value): value is string => typeof value === "string" && value.length > 0)

  return {
    model,
    ...(variant ? { variant } : {}),
    trigger: trigger.length > 0 ? trigger : [...DEFAULT_TRIGGER],
    lang,
    verbose: options.verbose === true,
    assistantTranslation: resolveAssistantTranslationMode(options.assistantTranslation),
  }
}

export function getEnvVarHint(provider: ProviderInfo | undefined): string {
  return provider?.env[0] || AUTH_ENV_FALLBACK
}

export function parseTranslatorModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash < 1 || slash === model.length - 1) {
    return { providerID: "anthropic", modelID: model }
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}
