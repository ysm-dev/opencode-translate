import type { Hooks } from "@opencode-ai/plugin"
import { buildInboundTranslationError, LLM_LANGUAGE, normalizeReason } from "../constants"
import {
  isQuestionArgs,
  type QuestionSnapshot,
  type QuestionToolOutput,
  restoreQuestionOutput,
  snapshotQuestions,
  translateQuestionArgs,
} from "../question-tool"
import { logError } from "./logging"
import { resolveSessionState } from "./state"
import { type HookContext, QUESTION_TOOL_ID } from "./types"

const questionSnapshots = new Map<string, QuestionSnapshot>()

export function resetQuestionSnapshots() {
  questionSnapshots.clear()
}

export function createToolExecuteBeforeHook(ctx: HookContext): NonNullable<Hooks["tool.execute.before"]> {
  return async (input, output) => {
    try {
      if (input.tool !== QUESTION_TOOL_ID) return
      const resolved = await resolveSessionState(ctx.client, ctx.directory, input.sessionID)
      const activeState = resolved.state
      if (!activeState) return

      const args = output.args as unknown
      if (!isQuestionArgs(args)) return

      const original = snapshotQuestions(args)
      if (activeState.translate_user_lang !== LLM_LANGUAGE) {
        try {
          await translateQuestionArgs(args, (text) =>
            ctx.translator.translateText({
              text,
              sourceLanguage: LLM_LANGUAGE,
              targetLanguage: activeState.translate_user_lang,
              direction: "outbound",
            }),
          )
        } catch (error) {
          args.questions.splice(0, args.questions.length, ...snapshotQuestions({ questions: original }))
          await logError(ctx.client, error)
          return
        }
      }

      questionSnapshots.set(input.callID, { original, translated: snapshotQuestions(args) })
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}

export function createToolExecuteAfterHook(ctx: HookContext): NonNullable<Hooks["tool.execute.after"]> {
  return async (input, output) => {
    try {
      if (input.tool !== QUESTION_TOOL_ID) return
      const snapshot = questionSnapshots.get(input.callID)
      if (!snapshot) return
      questionSnapshots.delete(input.callID)

      const resolved = await resolveSessionState(ctx.client, ctx.directory, input.sessionID)
      const activeState = resolved.state
      const translateCustomAnswer =
        activeState && activeState.translate_user_lang !== LLM_LANGUAGE
          ? (text: string) =>
              ctx.translator.translateText({
                text,
                sourceLanguage: activeState.translate_user_lang,
                targetLanguage: LLM_LANGUAGE,
                direction: "inbound",
              })
          : undefined

      await restoreQuestionOutput(output as QuestionToolOutput, snapshot, {
        ...(translateCustomAnswer ? { translateCustomAnswer } : {}),
        onTranslationError: async (error) => {
          if (!activeState) {
            await logError(ctx.client, error)
            return
          }
          await logError(
            ctx.client,
            buildInboundTranslationError(activeState.translate_user_lang, normalizeReason(error)),
          )
        },
      })
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}
