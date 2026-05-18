import { AUTH_ENV_FALLBACK, DEFAULT_TRANSLATOR_MODEL, DEFAULT_TRIGGER_KEYWORDS } from "./plugin"
import type { ProviderInfo, ResolvedTranslateOptions } from "./types"

export function resolveOptions(options: Record<string, unknown>): ResolvedTranslateOptions {
  const triggerKeywords = Array.isArray(options.triggerKeywords)
    ? options.triggerKeywords.filter((value): value is string => typeof value === "string" && value.length > 0)
    : DEFAULT_TRIGGER_KEYWORDS

  return {
    translatorModel:
      typeof options.translatorModel === "string" && options.translatorModel.includes("/")
        ? options.translatorModel
        : DEFAULT_TRANSLATOR_MODEL,
    triggerKeywords: triggerKeywords.length > 0 ? triggerKeywords : [...DEFAULT_TRIGGER_KEYWORDS],
    sourceLanguage:
      typeof options.sourceLanguage === "string" && options.sourceLanguage.trim() ? options.sourceLanguage : "en",
    displayLanguage:
      typeof options.displayLanguage === "string" && options.displayLanguage.trim() ? options.displayLanguage : "en",
    apiKey: typeof options.apiKey === "string" && options.apiKey.length > 0 ? options.apiKey : undefined,
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
