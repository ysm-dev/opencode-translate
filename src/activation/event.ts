import type { Hooks } from "@opencode-ai/plugin"
import { isTextPart, LLM_LANGUAGE, type MessageWithPartsLike, type TextPartLike, unwrapData } from "../constants"
import { composeTranslatedAssistantText, composeTranslationFailureText, extractEnglishHistoryText } from "../formatting"
import { getDisplayLanguageLabel } from "../labels"
import { logError } from "./logging"
import { resolveSessionState } from "./state"
import type { HookContext } from "./types"

type EventHook = NonNullable<Hooks["event"]>

const inFlightFinalTranslations = new Set<string>()

function latestAssistantMessage(messages: MessageWithPartsLike[]): MessageWithPartsLike | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.info.role === "assistant" && message.info.summary !== true) return message
  }
  return undefined
}

function lastNonEmptyTextPart(message: MessageWithPartsLike): (TextPartLike & { text: string }) | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (isTextPart(part) && part.text.trim().length > 0) return part
  }
  return undefined
}

async function composeFinalAssistantText(
  ctx: HookContext,
  text: string,
  targetLanguage: string,
  label: string,
): Promise<string> {
  try {
    const translated = await ctx.translator.translateText({
      text,
      sourceLanguage: LLM_LANGUAGE,
      targetLanguage,
      direction: "outbound",
    })
    return composeTranslatedAssistantText(text, label, translated)
  } catch (error) {
    await logError(ctx.client, error)
    return composeTranslationFailureText(text)
  }
}

async function patchPartViaServer(ctx: HookContext, sessionID: string, part: TextPartLike) {
  if (!ctx.serverUrl) throw new Error("client.part.update is required for final-message assistant translation")

  const url = new URL(
    `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(part.messageID)}/part/${encodeURIComponent(part.id)}`,
    ctx.serverUrl,
  )
  if (ctx.directory) url.searchParams.set("directory", ctx.directory)

  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(part),
  })
  if (!response.ok) {
    throw new Error(`Failed to update final assistant translation part: HTTP ${response.status}`)
  }
}

async function updatePart(ctx: HookContext, sessionID: string, part: TextPartLike) {
  const partUpdater = ctx.client.part?.update
  if (partUpdater) {
    const input = {
      sessionID,
      messageID: part.messageID,
      partID: part.id,
      ...(ctx.directory ? { directory: ctx.directory } : {}),
      part,
    }
    await partUpdater.call(ctx.client.part, input, { throwOnError: true })
    return
  }

  await patchPartViaServer(ctx, sessionID, part)
}

async function translateFinalAssistantMessage(ctx: HookContext, sessionID: string) {
  if (inFlightFinalTranslations.has(sessionID)) return
  inFlightFinalTranslations.add(sessionID)
  try {
    const resolved = await resolveSessionState(ctx.client, ctx.directory, sessionID)
    const activeState = resolved.state
    if (!activeState) return
    if (activeState.translate_user_lang === LLM_LANGUAGE) return

    const messages = unwrapData(
      await ctx.client.session.messages({
        path: { id: sessionID },
        query: { ...(ctx.directory ? { directory: ctx.directory } : {}), limit: 20 },
        throwOnError: true,
      }),
    )
    const message = latestAssistantMessage(messages)
    if (!message) return

    const part = lastNonEmptyTextPart(message)
    if (!part) return

    const label = getDisplayLanguageLabel(activeState.translate_user_lang)
    if (extractEnglishHistoryText(part.text, { nonce: activeState.translate_nonce, label }) !== part.text) return

    const updatedPart = {
      ...part,
      text: await composeFinalAssistantText(ctx, part.text, activeState.translate_user_lang, label),
    }

    await updatePart(ctx, sessionID, updatedPart)
  } finally {
    inFlightFinalTranslations.delete(sessionID)
  }
}

export function createEventHook(ctx: HookContext): EventHook {
  return async (input) => {
    if (ctx.options.assistantTranslation !== "final-message") return
    if (input.event.type !== "session.idle") return

    try {
      await translateFinalAssistantMessage(ctx, input.event.properties.sessionID)
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}
