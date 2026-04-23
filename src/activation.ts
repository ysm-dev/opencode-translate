import { randomBytes } from "node:crypto"
import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import {
  buildInboundTranslationError,
  buildStaleCacheError,
  isTextPart,
  isTranslateStateRecord,
  isUserAuthoredTextPart,
  LLM_LANGUAGE,
  type MessageWithPartsLike,
  NONCE_PATTERN,
  normalizeReason,
  PLUGIN_NAME,
  type PluginClientLike,
  parseTranslatorModel,
  type ResolvedTranslateOptions,
  resolveOptions,
  SPEC_VERSION,
  type StoredTextMetadata,
  type TextPartLike,
  type TranslateState,
  unwrapData,
} from "./constants"
import { composeTranslatedAssistantText, composeTranslationFailureText, extractEnglishHistoryText } from "./formatting"
import { getDisplayLanguageLabel } from "./labels"
import {
  isQuestionArgs,
  type QuestionSnapshot,
  type QuestionToolOutput,
  restoreQuestionOutput,
  snapshotQuestions,
  translateQuestionArgs,
} from "./question-tool"
import { createSyntheticPartID, createTranslator, hashText } from "./translator"

const sessionStateCache = new Map<string, TranslateState | null>()
const questionSnapshots = new Map<string, QuestionSnapshot>()
const QUESTION_TOOL_ID = "question"

export function __resetActivationCacheForTest() {
  sessionStateCache.clear()
  questionSnapshots.clear()
}

interface ResolvedSessionState {
  sessionActive: boolean
  canActivate: boolean
  state?: TranslateState
  storedMessages: MessageWithPartsLike[]
}

interface TriggerMatch {
  partArrayIndex: number
  eligibleIndex: number
  keyword: string
  offset: number
}

interface HookDependencies {
  translator?: {
    translateText(input: {
      text: string
      sourceLanguage: string
      targetLanguage: string
      direction: "inbound" | "outbound"
    }): Promise<string>
  }
}

function logError(client: PluginClientLike, error: unknown) {
  return client.app.log({
    body: {
      service: PLUGIN_NAME,
      level: "error",
      message: normalizeReason(error),
    },
  })
}

function createState(options: ResolvedTranslateOptions): TranslateState {
  return {
    translate_enabled: true,
    translate_source_lang: options.sourceLanguage,
    translate_display_lang: options.displayLanguage,
    translate_llm_lang: LLM_LANGUAGE,
    translate_nonce: randomBytes(16).toString("hex"),
  }
}

function createActivationBannerText(options: ResolvedTranslateOptions): string {
  const { modelID } = parseTranslatorModel(options.translatorModel)
  return `✓ Translation mode enabled · translator: ${modelID} · source: ${options.sourceLanguage} · display: ${options.displayLanguage}`
}

function asMetadata(part: TextPartLike): StoredTextMetadata {
  return (part.metadata ?? {}) as StoredTextMetadata
}

function extractStateFromMetadata(metadata: StoredTextMetadata | undefined): TranslateState | undefined {
  if (!isTranslateStateRecord(metadata)) return undefined
  return {
    translate_enabled: true,
    translate_source_lang: metadata.translate_source_lang,
    translate_display_lang: metadata.translate_display_lang,
    translate_llm_lang: LLM_LANGUAGE,
    translate_nonce: metadata.translate_nonce,
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
      if (message.info.role === "user" && part.synthetic !== true && fallback === undefined) {
        fallback = state
      }
    }
  }

  return fallback
}

function mergeTranslatedMetadata(state: TranslateState, part: TextPartLike, english: string): Record<string, unknown> {
  return {
    ...(part.metadata ?? {}),
    ...state,
    translate_source_hash: hashText(part.text ?? ""),
    translate_en: english,
  }
}

// OpenCode's flag semantics, observed from packages/opencode and packages/ui:
//   synthetic: true  -> hidden from the user UI, still sent to the LLM
//   ignored: true    -> hidden from the LLM, still shown in the user UI
// The translation preview, activation banner, and failure notices are
// user-facing status/diagnostic parts that must not leak into the LLM
// prompt, so they use synthetic:false + ignored:true.
function createSyntheticTextPart(
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
    synthetic: false,
    ignored: true,
    metadata,
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function findTriggerMatch(parts: TextPartLike[], triggerKeywords: string[]): TriggerMatch | undefined {
  let eligibleIndex = 0
  for (let partArrayIndex = 0; partArrayIndex < parts.length; partArrayIndex += 1) {
    const part = parts[partArrayIndex]
    if (!isUserAuthoredTextPart(part)) continue

    let bestForPart: TriggerMatch | undefined
    for (let keywordIndex = 0; keywordIndex < triggerKeywords.length; keywordIndex += 1) {
      const keyword = triggerKeywords[keywordIndex]
      const pattern = new RegExp(`(^|[ \\t\\r\\n\\f\\v])${escapeRegex(keyword)}(?=$|[ \\t\\r\\n\\f\\v])`)
      const match = pattern.exec(part.text)
      if (!match) continue
      const offset = match.index + match[1].length
      if (!bestForPart || offset < bestForPart.offset) {
        bestForPart = {
          partArrayIndex,
          eligibleIndex,
          keyword,
          offset,
        }
      }
    }

    if (bestForPart) return bestForPart
    eligibleIndex += 1
  }

  return undefined
}

export function stripTriggerKeyword(text: string, keyword: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const nextNewline = text.indexOf("\n", offset)
  const lineEnd = nextNewline === -1 ? text.length : nextNewline
  const line = text.slice(lineStart, lineEnd)
  const localOffset = offset - lineStart

  let rewrittenLine: string
  if (localOffset === 0 && line.startsWith(`${keyword} `)) {
    rewrittenLine = line.slice(keyword.length + 1)
  } else if (
    localOffset + keyword.length === line.length &&
    localOffset > 0 &&
    line.slice(localOffset - 1, localOffset) === " "
  ) {
    rewrittenLine = line.slice(0, localOffset - 1)
  } else if (
    localOffset > 0 &&
    line.slice(localOffset - 1, localOffset) === " " &&
    line.slice(localOffset + keyword.length, localOffset + keyword.length + 1) === " "
  ) {
    rewrittenLine = `${line.slice(0, localOffset - 1)} ${line.slice(localOffset + keyword.length + 1)}`
  } else {
    rewrittenLine = `${line.slice(0, localOffset)}${line.slice(localOffset + keyword.length)}`
  }

  return `${text.slice(0, lineStart)}${rewrittenLine}${text.slice(lineEnd)}`
}

async function resolveSessionState(
  client: PluginClientLike,
  directory: string | undefined,
  sessionID: string,
): Promise<ResolvedSessionState> {
  const session = unwrapData(
    await client.session.get({
      path: { id: sessionID },
      query: { ...(directory ? { directory } : {}) },
      throwOnError: true,
    }),
  )
  if (session.parentID != null) {
    sessionStateCache.set(sessionID, null)
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
  sessionStateCache.set(sessionID, state ?? null)

  return {
    sessionActive: Boolean(state),
    canActivate: storedMessages.length === 0,
    state: state ?? undefined,
    storedMessages,
  }
}

function shouldRequireCache(part: TextPartLike): boolean {
  return isUserAuthoredTextPart(part) && part.text.trim().length > 0
}

export function createHooks(ctx: PluginInput, rawOptions: PluginOptions = {}, deps: HookDependencies = {}): Hooks {
  if (process.env.OPENCODE_TRANSLATE_DISABLE === "1") {
    return {}
  }

  const client = ctx.client as unknown as PluginClientLike
  const options = resolveOptions(rawOptions)
  const translator = deps.translator ?? createTranslator(client, options)

  return {
    "chat.message": async (input, output) => {
      // Hooks must never throw. A thrown error propagates into OpenCode's
      // Effect runtime as a defect, kills the fiber, and stalls the session —
      // to the user this looks like infinite loading with no error message.
      // Instead, we log the failure and fall back to the untranslated text so
      // the chat keeps moving.
      try {
        const resolved = await resolveSessionState(client, ctx.directory, input.sessionID)
        let activeState = resolved.state
        let activatedThisTurn = false

        if (!activeState && resolved.canActivate) {
          const match = findTriggerMatch(output.parts as TextPartLike[], options.triggerKeywords)
          if (match) {
            const part = output.parts[match.partArrayIndex] as TextPartLike & { text: string }
            const originalText = part.text
            part.text = stripTriggerKeyword(part.text, match.keyword, match.offset)
            activeState = createState(options)
            if (!NONCE_PATTERN.test(activeState.translate_nonce)) {
              part.text = originalText
              await logError(client, new Error("Generated invalid translation nonce"))
              return
            }
            activatedThisTurn = true
            sessionStateCache.set(input.sessionID, activeState)
          }
        }

        if (!activeState) return

        const nextParts: TextPartLike[] = []
        let eligibleIndex = 0
        const translationErrors: { part: TextPartLike; error: unknown }[] = []

        for (const part of output.parts as TextPartLike[]) {
          nextParts.push(part)
          if (!isUserAuthoredTextPart(part)) continue

          const currentEligibleIndex = eligibleIndex
          eligibleIndex += 1
          if (part.text.trim().length === 0) continue

          try {
            const english = await translator.translateText({
              text: part.text,
              sourceLanguage: activeState.translate_source_lang,
              targetLanguage: LLM_LANGUAGE,
              direction: "inbound",
            })

            const sourceHash = hashText(part.text)
            part.metadata = {
              ...(part.metadata ?? {}),
              ...mergeTranslatedMetadata(activeState, part, english),
            }

            nextParts.push(
              createSyntheticTextPart(part.sessionID, part.messageID, `→ EN: ${english}`, {
                translate_role: "translation_preview",
                translate_nonce: activeState.translate_nonce,
                translate_source_hash: sourceHash,
                translate_part_index: currentEligibleIndex,
              }),
            )
          } catch (error) {
            // Fall back to sending the original text to the LLM so the user
            // still gets a response. Surface the error as a synthetic part.
            translationErrors.push({ part, error })
            const wrapped = buildInboundTranslationError(activeState.translate_source_lang, normalizeReason(error))
            await logError(client, wrapped)
            nextParts.push(
              createSyntheticTextPart(
                part.sessionID,
                part.messageID,
                `⚠️ Translation failed: ${normalizeReason(error)}. Original text will be sent to the model.`,
                {
                  translate_role: "translation_failure",
                  translate_nonce: activeState.translate_nonce,
                  translate_part_index: currentEligibleIndex,
                },
              ),
            )
          }
        }

        // If we activated this turn but translation failed for every
        // user-authored part, roll back activation so the next turn does a
        // clean retry instead of cementing broken state.
        if (activatedThisTurn && translationErrors.length > 0 && eligibleIndex === translationErrors.length) {
          sessionStateCache.set(input.sessionID, null)
          return
        }

        if (activatedThisTurn) {
          nextParts.push(
            createSyntheticTextPart(input.sessionID, output.message.id, createActivationBannerText(options), {
              ...activeState,
              translate_role: "activation_banner",
              translate_spec_version: SPEC_VERSION,
            }),
          )
        }

        output.parts.splice(0, output.parts.length, ...(nextParts as typeof output.parts))
      } catch (error) {
        await logError(client, error)
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const sessionID = output.messages[0]?.info.sessionID
        if (!sessionID) return

        const resolved = await resolveSessionState(client, ctx.directory, sessionID)
        const activeState = resolved.state
        if (!activeState) return

        for (const message of output.messages as MessageWithPartsLike[]) {
          if (message.info.role === "user") {
            for (const part of message.parts) {
              if (!isTextPart(part)) continue
              if (!shouldRequireCache(part)) continue
              const metadata = asMetadata(part)
              const sourceHash = hashText(part.text)
              if (
                metadata.translate_enabled === true &&
                metadata.translate_nonce === activeState.translate_nonce &&
                metadata.translate_source_hash === sourceHash &&
                typeof metadata.translate_en === "string"
              ) {
                part.text = metadata.translate_en
                continue
              }

              // Stale cache or untranslated text. Send it through as-is
              // (English history would be ideal, but we shouldn't block the
              // session). Also log so the user can diagnose if needed.
              await logError(client, buildStaleCacheError())
            }
          }

          if (message.info.role === "assistant") {
            for (const part of message.parts) {
              if (!isTextPart(part)) continue
              part.text = extractEnglishHistoryText(part.text, activeState.translate_nonce)
            }
          }
        }
      } catch (error) {
        await logError(client, error)
      }
    },
    "experimental.text.complete": async (input, output) => {
      try {
        const resolved = await resolveSessionState(client, ctx.directory, input.sessionID)
        const activeState = resolved.state
        if (!activeState) return

        const message = unwrapData(
          await client.session.message({
            path: { id: input.sessionID, messageID: input.messageID },
            query: { ...(ctx.directory ? { directory: ctx.directory } : {}) },
            throwOnError: true,
          }),
        ) as MessageWithPartsLike & { info: Record<string, unknown> }

        if (message.info.role !== "assistant") return
        if (message.info.summary === true) return
        if (activeState.translate_display_lang === LLM_LANGUAGE || output.text.length === 0) return

        try {
          const translated = await translator.translateText({
            text: output.text,
            sourceLanguage: LLM_LANGUAGE,
            targetLanguage: activeState.translate_display_lang,
            direction: "outbound",
          })

          output.text = composeTranslatedAssistantText(
            output.text,
            getDisplayLanguageLabel(activeState.translate_display_lang),
            translated,
            activeState.translate_nonce,
          )
        } catch (error) {
          output.text = composeTranslationFailureText(output.text, activeState.translate_nonce)
          await logError(client, error)
        }
      } catch (error) {
        await logError(client, error)
      }
    },
    // Translate the built-in `question` tool so the TUI dialog renders in
    // the user's displayLanguage. The tool output string is restored back
    // to English in `tool.execute.after` so the main LLM context stays
    // English-only.
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool !== QUESTION_TOOL_ID) return
        const resolved = await resolveSessionState(client, ctx.directory, input.sessionID)
        const activeState = resolved.state
        if (!activeState) return
        if (activeState.translate_display_lang === LLM_LANGUAGE) return

        const args = output.args as unknown
        if (!isQuestionArgs(args)) return

        const original = snapshotQuestions(args)
        try {
          await translateQuestionArgs(args, (text) =>
            translator.translateText({
              text,
              sourceLanguage: LLM_LANGUAGE,
              targetLanguage: activeState.translate_display_lang,
              direction: "outbound",
            }),
          )
        } catch (error) {
          // Translation failed: restore the originals so the dialog at least
          // renders in English instead of a half-translated mess.
          args.questions.splice(0, args.questions.length, ...snapshotQuestions({ questions: original }))
          await logError(client, error)
          return
        }

        const translated = snapshotQuestions(args)
        questionSnapshots.set(input.callID, { original, translated })
      } catch (error) {
        await logError(client, error)
      }
    },
    "tool.execute.after": async (input, output) => {
      try {
        if (input.tool !== QUESTION_TOOL_ID) return
        const snapshot = questionSnapshots.get(input.callID)
        if (!snapshot) return
        questionSnapshots.delete(input.callID)
        restoreQuestionOutput(output as QuestionToolOutput, snapshot)
      } catch (error) {
        await logError(client, error)
      }
    },
  }
}
