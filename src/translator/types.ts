import type { generateText } from "ai"
import type { createCredentialResolver } from "../auth"

export interface TranslatorDependencies {
  generateTextImpl?: typeof generateText
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  credentialResolver?: ReturnType<typeof createCredentialResolver>
  timeoutMs?: number
}

export interface TranslateTextInput {
  text: string
  sourceLanguage: string
  targetLanguage: string
  direction: "inbound" | "outbound"
}

export interface TranslateTextsInput {
  texts: readonly string[]
  sourceLanguage: string
  targetLanguage: string
  direction: "inbound" | "outbound"
}
