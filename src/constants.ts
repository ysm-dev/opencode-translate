export const PLUGIN_NAME = "opencode-translate"
export const SPEC_VERSION = 1
export const LLM_LANGUAGE = "en"
export const DEFAULT_TRANSLATOR_MODEL = "anthropic/claude-haiku-4-5"
export const DEFAULT_TRIGGER_KEYWORDS = ["$en"]
export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"
export const NONCE_PATTERN = /^[0-9a-f]{32}$/
export const PLACEHOLDER_PATTERN = /⟦OCTX:[^⟧]+⟧/g
export const FAILURE_NOTICE = "_Translation unavailable for this segment._"
export const AUTH_ENV_FALLBACK = "the provider's API key env var"
export const USER_AGENT = `${PLUGIN_NAME}/0.0.0`

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ProviderSource = "env" | "config" | "custom" | "api"

export interface TranslateOptions {
  translatorModel?: string
  triggerKeywords?: string[]
  sourceLanguage?: string
  displayLanguage?: string
  apiKey?: string
  verbose?: boolean
}

export interface ResolvedTranslateOptions {
  translatorModel: string
  triggerKeywords: string[]
  sourceLanguage: string
  displayLanguage: string
  apiKey?: string
  verbose: boolean
}

export interface TranslateState {
  translate_enabled: true
  translate_source_lang: string
  translate_display_lang: string
  translate_llm_lang: typeof LLM_LANGUAGE
  translate_nonce: string
}

export interface StoredTextMetadata extends Record<string, unknown> {
  translate_enabled?: boolean
  translate_source_lang?: string
  translate_display_lang?: string
  translate_llm_lang?: string
  translate_nonce?: string
  translate_role?: string
  translate_spec_version?: number
  translate_source_hash?: string
  translate_en?: string
  translate_part_index?: number
  compaction_continue?: boolean
}

export interface SessionLike {
  id: string
  parentID?: string | null
}

export interface MessageLike {
  id: string
  sessionID: string
  role: string
}

export interface TextPartLike {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

export interface MessageWithPartsLike {
  info: MessageLike
  parts: TextPartLike[]
}

export interface ProviderInfo {
  id: string
  source: ProviderSource
  env: string[]
  key?: string
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

export interface ProviderListResponseLike {
  all: ProviderInfo[]
}

export interface ApiAuthInfo {
  type: "api"
  key: string
  metadata?: Record<string, string>
}

export interface OAuthInfo {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}

export interface WellKnownInfo {
  type: "wellknown"
  key: string
  token: string
}

export type AuthInfo = ApiAuthInfo | OAuthInfo | WellKnownInfo

export interface SDKResponseLike<T> {
  data?: T
}

export interface PluginClientLike {
  session: {
    get(
      input: (
        | { sessionID: string; directory?: string; workspace?: string }
        | { path: { id: string }; query?: { directory?: string; workspace?: string } }
      ) & { throwOnError?: boolean },
      options?: { throwOnError?: boolean },
    ): Promise<SessionLike | SDKResponseLike<SessionLike>>
    messages(
      input: (
        | { sessionID: string; directory?: string; workspace?: string }
        | { path: { id: string }; query?: { directory?: string; workspace?: string; limit?: number; before?: string } }
      ) & { throwOnError?: boolean },
      options?: { throwOnError?: boolean },
    ): Promise<MessageWithPartsLike[] | SDKResponseLike<MessageWithPartsLike[]>>
    message(
      input: (
        | { sessionID: string; messageID: string; directory?: string; workspace?: string }
        | { path: { id: string; messageID: string }; query?: { directory?: string; workspace?: string } }
      ) & { throwOnError?: boolean },
      options?: { throwOnError?: boolean },
    ): Promise<MessageWithPartsLike | SDKResponseLike<MessageWithPartsLike>>
  }
  provider: {
    list(options?: {
      throwOnError?: boolean
    }): Promise<ProviderListResponseLike | SDKResponseLike<ProviderListResponseLike>>
  }
  auth: {
    set(input: { path: { id: string }; body: AuthInfo }): Promise<unknown>
  }
  app: {
    log(input: {
      body: {
        service: string
        level: string
        message: string
        extra?: Record<string, unknown>
      }
    }): Promise<unknown>
  }
}

export interface TranslationPreviewInfo {
  english: string
  sourceHash: string
  eligibleIndex: number
}

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

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function unwrapData<T>(value: T | SDKResponseLike<T>): T {
  if (value && typeof value === "object" && "data" in value && (value as SDKResponseLike<T>).data !== undefined) {
    return (value as SDKResponseLike<T>).data as T
  }
  return value as T
}

export function normalizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split(/\r?\n/, 1)[0].trim().slice(0, 200)
}

export function buildInboundTranslationError(sourceLanguage: string, reason: string): Error {
  return new Error(
    `[${PLUGIN_NAME}:INBOUND_TRANSLATION_FAILED] Failed to translate user message from ${sourceLanguage} to en: ${reason}`,
  )
}

export function buildStaleCacheError(): Error {
  return new Error(
    `[${PLUGIN_NAME}:STALE_CACHE] A previously translated user message was edited. Resend the message or start a new session.`,
  )
}

export function buildAuthUnavailableError(providerID: string, envVar: string): Error {
  return new Error(
    `[${PLUGIN_NAME}:AUTH_UNAVAILABLE] No credential found for provider "${providerID}". Set ${envVar} in the environment, run "opencode auth login ${providerID}", or set options.apiKey in opencode.json.`,
  )
}

export function buildOAuthRefreshError(providerID: string, reason: string): Error {
  return new Error(
    `[${PLUGIN_NAME}:OAUTH_REFRESH_FAILED] Failed to refresh OAuth token for provider "${providerID}": ${reason}. Re-authenticate with "opencode auth login ${providerID}".`,
  )
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
