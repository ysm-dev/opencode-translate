import type { Hooks } from "@opencode-ai/plugin"
import { LLM_LANGUAGE, type MessageWithPartsLike, unwrapData } from "../constants"
import { composeTranslatedAssistantText, composeTranslationFailureText } from "../formatting"
import { getDisplayLanguageLabel } from "../labels"
import { logError } from "./logging"
import { resolveSessionState } from "./state"
import type { HookContext } from "./types"

type TextCompleteHook = NonNullable<Hooks["experimental.text.complete"]>

export function createTextCompleteHook(ctx: HookContext): TextCompleteHook {
  return async (input, output) => {
    try {
      const resolved = await resolveSessionState(ctx.client, ctx.directory, input.sessionID)
      const activeState = resolved.state
      if (!activeState) return

      const message = unwrapData(
        await ctx.client.session.message({
          path: { id: input.sessionID, messageID: input.messageID },
          query: { ...(ctx.directory ? { directory: ctx.directory } : {}) },
          throwOnError: true,
        }),
      ) as MessageWithPartsLike & { info: Record<string, unknown> }

      if (message.info.role !== "assistant") return
      if (message.info.summary === true) return
      if (activeState.translate_user_lang === LLM_LANGUAGE || output.text.length === 0) return

      try {
        const translated = await ctx.translator.translateText({
          text: output.text,
          sourceLanguage: LLM_LANGUAGE,
          targetLanguage: activeState.translate_user_lang,
          direction: "outbound",
        })
        output.text = composeTranslatedAssistantText(
          output.text,
          getDisplayLanguageLabel(activeState.translate_user_lang),
          translated,
          activeState.translate_nonce,
        )
      } catch (error) {
        output.text = composeTranslationFailureText(output.text, activeState.translate_nonce)
        await logError(ctx.client, error)
      }
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}
