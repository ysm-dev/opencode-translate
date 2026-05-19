import type { LLM_LANGUAGE } from "./plugin"

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ProviderSource = "env" | "config" | "custom" | "api"

export interface ResolvedTranslateOptions {
  model: string
  trigger: string[]
  lang: string
  verbose: boolean
}

export interface TranslateState {
  translate_enabled: true
  translate_user_lang: string
  translate_llm_lang: typeof LLM_LANGUAGE
  translate_nonce: string
}

export interface StoredTextMetadata extends Record<string, unknown> {
  translate_enabled?: boolean
  translate_user_lang?: string
  translate_llm_lang?: string
  translate_nonce?: string
  translate_role?: string
  translate_spec_version?: number
  translate_source_hash?: string
  translate_en?: string
  translate_part_index?: number
  compaction_continue?: boolean
}

interface SessionLike {
  id: string
  parentID?: string | null
}

interface MessageLike {
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

export interface ProviderModelInfo {
  id?: string
  api?: {
    id?: string
    url?: string
    npm?: string
  }
  headers?: Record<string, string>
  options?: Record<string, unknown>
  capabilities?: {
    temperature?: boolean
  }
}

export interface ProviderInfo {
  id: string
  source: ProviderSource
  env: string[]
  key?: string
  options?: Record<string, unknown>
  models?: Record<string, ProviderModelInfo>
}

interface ProviderListResponseLike {
  all: ProviderInfo[]
}

interface ApiAuthInfo {
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

interface WellKnownInfo {
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
