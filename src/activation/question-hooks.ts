import type { Hooks } from "@opencode-ai/plugin"
import { buildInboundTranslationError, LLM_LANGUAGE, normalizeReason } from "../constants"
import {
  isQuestionArgs,
  type QuestionSnapshot,
  type QuestionToolOutput,
  restoreQuestionArgs,
  restoreQuestionOutput,
  snapshotQuestions,
  translateQuestionArgs,
} from "../question-tool"
import { logError } from "./logging"
import { resolveSessionState } from "./state"
import { type HookContext, QUESTION_TOOL_ID } from "./types"

const QUESTION_SNAPSHOT_LIMIT = 1_000

const questionSnapshots = new Map<string, QuestionSnapshot>()

function pruneQuestionSnapshots() {
  while (questionSnapshots.size > QUESTION_SNAPSHOT_LIMIT) {
    for (const callID of questionSnapshots.keys()) {
      questionSnapshots.delete(callID)
      break
    }
  }
}

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

      if (!isQuestionArgs(output.args)) return
      const args = output.args

      const original = snapshotQuestions(args)
      if (activeState.translate_user_lang !== LLM_LANGUAGE) {
        try {
          await translateQuestionArgs(args, (texts) =>
            ctx.translator.translateTexts
              ? ctx.translator.translateTexts({
                  texts,
                  sourceLanguage: LLM_LANGUAGE,
                  targetLanguage: activeState.translate_user_lang,
                  direction: "outbound",
                })
              : Promise.all(
                  texts.map((text) =>
                    ctx.translator.translateText({
                      text,
                      sourceLanguage: LLM_LANGUAGE,
                      targetLanguage: activeState.translate_user_lang,
                      direction: "outbound",
                    }),
                  ),
                ),
          )
        } catch (error) {
          args.questions.splice(0, args.questions.length, ...snapshotQuestions({ questions: original }))
          await logError(ctx.client, error)
          return
        }
      }

      questionSnapshots.set(input.callID, {
        original,
        translated: snapshotQuestions(args),
        userLanguage: activeState.translate_user_lang,
      })
      pruneQuestionSnapshots()
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
      if (isQuestionArgs(input.args)) restoreQuestionArgs(input.args, snapshot.original)

      if (snapshot.userLanguage === LLM_LANGUAGE) {
        await restoreQuestionOutput(output as QuestionToolOutput, snapshot)
        return
      }

      await restoreQuestionOutput(output as QuestionToolOutput, snapshot, {
        translateCustomAnswers: (texts: readonly string[]) =>
          ctx.translator.translateTexts
            ? ctx.translator.translateTexts({
                texts,
                sourceLanguage: snapshot.userLanguage,
                targetLanguage: LLM_LANGUAGE,
                direction: "inbound",
              })
            : Promise.all(
                texts.map((text) =>
                  ctx.translator.translateText({
                    text,
                    sourceLanguage: snapshot.userLanguage,
                    targetLanguage: LLM_LANGUAGE,
                    direction: "inbound",
                  }),
                ),
              ),
        onTranslationError: async (error) => {
          await logError(ctx.client, buildInboundTranslationError(snapshot.userLanguage, normalizeReason(error)))
        },
      })
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}
