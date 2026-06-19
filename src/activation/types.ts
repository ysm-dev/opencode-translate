import type { PluginClientLike, ResolvedTranslateOptions, TranslateState } from "../constants"

export const INACTIVE_ROOT_SESSION = "inactive-root"
export const INACTIVE_CHILD_SESSION = "inactive-child"
export const QUESTION_TOOL_ID = "question"

export type CachedSessionState = TranslateState | typeof INACTIVE_ROOT_SESSION | typeof INACTIVE_CHILD_SESSION

export interface ResolvedSessionState {
  sessionActive: boolean
  canActivate: boolean
  state?: TranslateState
  storedMessages: import("../constants").MessageWithPartsLike[]
}

export interface TriggerMatch {
  partArrayIndex: number
  eligibleIndex: number
  keyword: string
  offset: number
}

interface TranslatorLike {
  translateText(input: {
    text: string
    sourceLanguage: string
    targetLanguage: string
    direction: "inbound" | "outbound"
  }): Promise<string>
}

export interface HookDependencies {
  translator?: TranslatorLike
}

export interface HookContext {
  client: PluginClientLike
  directory?: string
  options: ResolvedTranslateOptions
  translator: TranslatorLike
}
