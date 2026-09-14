import type { Plugin } from "@opencode/plugin"
import { LLM_LANGUAGE, PLUGIN_NAME } from "./constants"
import {
  isQuestionArgs,
  type QuestionSnapshot,
  restoreQuestionOutput,
  snapshotQuestions,
  translateQuestionArgs,
} from "./question-tool"
import type { createState } from "./state"
import type { Translator } from "./translator"

export async function registerQuestionHooks(
  ctx: Plugin.Context,
  state: ReturnType<typeof createState>,
  translator: Translator,
) {
  const snapshots = new Map<string, QuestionSnapshot>()
  await ctx.tool.hook("execute.before", async (event) => {
    if (event.tool !== "question" || !isQuestionArgs(event.input)) return
    const lang = await state.language(event.sessionID)
    if (!lang) return
    const original = snapshotQuestions(event.input)
    try {
      // The after hook's input is readonly in v2. Persist the original for the
      // context hook instead of mutating completed tool calls in the transcript.
      await ctx.storage.set(`questions/${event.sessionID}/${event.id}`, JSON.stringify({ questions: original }))
      await translateQuestionArgs(event.input, (texts) => translator.texts(texts, LLM_LANGUAGE, lang))
      snapshots.set(`${event.sessionID}/${event.id}`, {
        original,
        translated: snapshotQuestions(event.input),
        userLanguage: lang,
      })
      // Cancellation defects in older hosts bypass execute.after.
      if (snapshots.size > 1000) snapshots.delete(snapshots.keys().next().value!)
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] question translation failed`, error)
    }
  })
  await ctx.tool.hook("execute.after", async (event) => {
    const key = `${event.sessionID}/${event.id}`
    const snapshot = snapshots.get(key)
    if (!snapshot) return
    snapshots.delete(key)
    if (event.status !== "completed") return
    // v2 carries both structured output and model-visible content.
    const result = {
      output: typeof event.result.content === "string" ? event.result.content : "",
      metadata: { ...event.result.metadata },
    }
    await restoreQuestionOutput(result, snapshot, {
      translateCustomAnswers: (texts) => translator.texts(texts, snapshot.userLanguage, LLM_LANGUAGE),
      onTranslationError: async (error) => console.error(`[${PLUGIN_NAME}] answer translation failed`, error),
    })
    event.result = {
      ...event.result,
      content: result.output,
      output: { answers: result.metadata.answers },
      metadata: result.metadata,
    }
  })
  return () => snapshots.clear()
}
