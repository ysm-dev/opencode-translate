import { randomBytes } from "node:crypto"
import {
  isTextPart,
  LLM_LANGUAGE,
  type MessageWithPartsLike,
  type PluginClientLike,
  type ResolvedTranslateOptions,
  type TranslateState,
  unwrapData,
} from "../constants"
import { asMetadata, extractStateFromMetadata } from "./metadata"
import {
  type CachedSessionState,
  INACTIVE_CHILD_SESSION,
  INACTIVE_ROOT_SESSION,
  type ResolvedSessionState,
} from "./types"

const sessionStateCache = new Map<string, CachedSessionState>()

export function resetSessionStateCache() {
  sessionStateCache.clear()
}

export function cacheSessionState(sessionID: string, state: CachedSessionState) {
  sessionStateCache.set(sessionID, state)
}

export function createState(options: ResolvedTranslateOptions): TranslateState {
  return {
    translate_enabled: true,
    translate_source_lang: options.sourceLanguage,
    translate_display_lang: options.displayLanguage,
    translate_llm_lang: LLM_LANGUAGE,
    translate_nonce: randomBytes(16).toString("hex"),
  }
}

export function extractStoredState(messages: MessageWithPartsLike[]): TranslateState | undefined {
  let fallback: TranslateState | undefined

  for (const message of messages) {
    for (const part of message.parts) {
      if (!isTextPart(part)) continue
      const metadata = asMetadata(part)
      const state = extractStateFromMetadata(metadata)
      if (!state) continue
      if (metadata.translate_role === "activation_banner") return state
      if (message.info.role === "user" && part.synthetic !== true && fallback === undefined) fallback = state
    }
  }

  return fallback
}

function cachedStateResult(cached: CachedSessionState): ResolvedSessionState {
  if (cached === INACTIVE_ROOT_SESSION) return { sessionActive: false, canActivate: true, storedMessages: [] }
  if (cached === INACTIVE_CHILD_SESSION) return { sessionActive: false, canActivate: false, storedMessages: [] }
  return { sessionActive: true, canActivate: false, state: cached, storedMessages: [] }
}

export async function resolveSessionState(
  client: PluginClientLike,
  directory: string | undefined,
  sessionID: string,
): Promise<ResolvedSessionState> {
  const cached = sessionStateCache.get(sessionID)
  if (cached !== undefined) return cachedStateResult(cached)

  const session = unwrapData(
    await client.session.get({
      path: { id: sessionID },
      query: { ...(directory ? { directory } : {}) },
      throwOnError: true,
    }),
  )
  if (session.parentID != null) {
    sessionStateCache.set(sessionID, INACTIVE_CHILD_SESSION)
    return { sessionActive: false, canActivate: false, storedMessages: [] }
  }

  const storedMessages = unwrapData(
    await client.session.messages({
      path: { id: sessionID },
      query: { ...(directory ? { directory } : {}) },
      throwOnError: true,
    }),
  )
  const state = extractStoredState(storedMessages)
  sessionStateCache.set(sessionID, state ?? INACTIVE_ROOT_SESSION)

  return {
    sessionActive: Boolean(state),
    canActivate: !state,
    state: state ?? undefined,
    storedMessages,
  }
}
