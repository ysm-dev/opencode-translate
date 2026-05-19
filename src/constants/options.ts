import { AUTH_ENV_FALLBACK, DEFAULT_TRIGGER, PLUGIN_NAME } from "./plugin"
import type { ProviderInfo, ResolvedTranslateOptions } from "./types"

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

  const trigger = Array.isArray(options.trigger)
    ? options.trigger.filter((value): value is string => typeof value === "string" && value.length > 0)
    : DEFAULT_TRIGGER

  return {
    model,
    trigger: trigger.length > 0 ? trigger : [...DEFAULT_TRIGGER],
    lang,
    verbose: options.verbose === true,
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
