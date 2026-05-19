import type { Hooks } from "@opencode-ai/plugin"
import {
  buildInboundTranslationError,
  isUserAuthoredTextPart,
  LLM_LANGUAGE,
  NONCE_PATTERN,
  normalizeReason,
  type TextPartLike,
  type TranslateState,
} from "../constants"
import { hashText } from "../translator"
import { logError } from "./logging"
import { mergeTranslatedMetadata } from "./metadata"
import { createActivationBannerPart, createActivationBannerText, createLlmOnlyTextPart } from "./parts"
import { cacheSessionState, createState, resolveSessionState } from "./state"
import { findTriggerMatch, stripTriggerKeyword } from "./trigger"
import { type HookContext, INACTIVE_ROOT_SESSION, type ResolvedSessionState } from "./types"

type ChatMessageHook = NonNullable<Hooks["chat.message"]>
type ChatMessageInput = Parameters<ChatMessageHook>[0]
type ChatMessageOutput = Parameters<ChatMessageHook>[1]

interface ActivationResult {
  state?: TranslateState
  activatedThisTurn: boolean
  aborted: boolean
}

interface PartProcessingResult {
  nextParts: TextPartLike[]
  eligibleIndex: number
  errors: { part: TextPartLike; error: unknown }[]
  firstUserTextPart?: TextPartLike & { text: string }
}

async function activateFromTrigger(
  ctx: HookContext,
  input: ChatMessageInput,
  output: ChatMessageOutput,
  resolved: ResolvedSessionState,
): Promise<ActivationResult> {
  if (resolved.state || !resolved.canActivate)
    return { state: resolved.state, activatedThisTurn: false, aborted: false }

  const match = findTriggerMatch(output.parts as TextPartLike[], ctx.options.trigger)
  if (!match) return { activatedThisTurn: false, aborted: false }

  const part = output.parts[match.partArrayIndex] as TextPartLike & { text: string }
  const originalText = part.text
  part.text = stripTriggerKeyword(part.text, match.keyword, match.offset)
  const state = createState(ctx.options)
  if (!NONCE_PATTERN.test(state.translate_nonce)) {
    part.text = originalText
    await logError(ctx.client, new Error("Generated invalid translation nonce"))
    return { activatedThisTurn: false, aborted: true }
  }

  cacheSessionState(input.sessionID, state)
  return { state, activatedThisTurn: true, aborted: false }
}

async function translateUserPart(
  ctx: HookContext,
  state: TranslateState,
  part: TextPartLike & { text: string },
  eligibleIndex: number,
  nextParts: TextPartLike[],
  errors: { part: TextPartLike; error: unknown }[],
) {
  try {
    const english = await ctx.translator.translateText({
      text: part.text,
      sourceLanguage: state.translate_user_lang,
      targetLanguage: LLM_LANGUAGE,
      direction: "inbound",
    })
    const sourceHash = hashText(part.text)
    part.metadata = { ...(part.metadata ?? {}), ...mergeTranslatedMetadata(state, part, english) }
    part.text = `${part.text}\n\n→ EN: ${english}`
    nextParts.push(
      createLlmOnlyTextPart(part.sessionID, part.messageID, english, {
        translate_role: "llm_only_translation",
        translate_nonce: state.translate_nonce,
        translate_source_hash: sourceHash,
        translate_part_index: eligibleIndex,
      }),
    )
  } catch (error) {
    errors.push({ part, error })
    const reason = normalizeReason(error)
    await logError(ctx.client, buildInboundTranslationError(state.translate_user_lang, reason))
    const originalText = part.text
    part.text = `${originalText}\n\n⚠️ Translation failed: ${reason}. Original text was sent to the model.`
    part.ignored = true
    nextParts.push(
      createLlmOnlyTextPart(part.sessionID, part.messageID, originalText, {
        translate_role: "llm_only_fallback",
        translate_nonce: state.translate_nonce,
        translate_part_index: eligibleIndex,
      }),
    )
  }
}

async function processParts(
  ctx: HookContext,
  output: ChatMessageOutput,
  state: TranslateState,
): Promise<PartProcessingResult> {
  const result: PartProcessingResult = { nextParts: [], eligibleIndex: 0, errors: [] }
  for (const part of output.parts as TextPartLike[]) {
    result.nextParts.push(part)
    if (!isUserAuthoredTextPart(part)) continue
    result.firstUserTextPart ??= part
    const currentEligibleIndex = result.eligibleIndex
    result.eligibleIndex += 1
    if (part.text.trim().length === 0) continue
    await translateUserPart(ctx, state, part, currentEligibleIndex, result.nextParts, result.errors)
  }
  return result
}

function appendActivationBanner(
  ctx: HookContext,
  input: ChatMessageInput,
  output: ChatMessageOutput,
  state: TranslateState,
  processed: PartProcessingResult,
) {
  const bannerText = createActivationBannerText(ctx.options)
  if (processed.firstUserTextPart !== undefined) {
    processed.firstUserTextPart.text = `${processed.firstUserTextPart.text}\n\n${bannerText}`
  }
  processed.nextParts.push(createActivationBannerPart(input.sessionID, output.message.id, state, bannerText))
}

async function handleChatMessage(ctx: HookContext, input: ChatMessageInput, output: ChatMessageOutput) {
  const resolved = await resolveSessionState(ctx.client, ctx.directory, input.sessionID)
  const activation = await activateFromTrigger(ctx, input, output, resolved)
  if (activation.aborted || !activation.state) return

  const processed = await processParts(ctx, output, activation.state)
  if (
    activation.activatedThisTurn &&
    processed.errors.length > 0 &&
    processed.eligibleIndex === processed.errors.length
  ) {
    cacheSessionState(input.sessionID, INACTIVE_ROOT_SESSION)
    return
  }

  if (activation.activatedThisTurn) appendActivationBanner(ctx, input, output, activation.state, processed)
  output.parts.splice(0, output.parts.length, ...(processed.nextParts as typeof output.parts))
}

export function createChatMessageHook(ctx: HookContext): ChatMessageHook {
  return async (input, output) => {
    try {
      await handleChatMessage(ctx, input, output)
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}
