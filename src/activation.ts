import type { Plugin } from "@opencode/plugin"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import { registerModelTranslation } from "./aisdk"
import { LLM_LANGUAGE, PLUGIN_NAME, resolveOptions } from "./constants"
import { isQuestionArgs } from "./question-tool"
import { registerQuestionHooks } from "./questions"
import { type ResponseTranslation, translateResponse } from "./response"
import { createState, METADATA_KEY, readMetadata } from "./state"
import { createTranslator } from "./translator"
import { requireHttpTransport } from "./transport"

export async function setup(ctx: Plugin.Context) {
  if (process.env.OPENCODE_TRANSLATE_DISABLE === "1") return
  const options = resolveOptions(ctx.options)
  const controller = new AbortController()
  const translator = createTranslator(ctx, options, controller.signal)
  const state = createState(ctx)

  await ctx.session.hook("prompt", async (event) => {
    const session = await ctx.session.get({ sessionID: event.sessionID })
    if (session.parentID) return
    // Hooks can be invoked more than once during concurrent admission retries.
    const existing = readMetadata(event.metadata?.[METADATA_KEY])
    if (existing?.display === event.prompt.text) return
    const lang = await state.language(event.sessionID)
    const source = lang ? event.prompt.text : stripTrigger(event.prompt.text, options.trigger)
    if (source === undefined) return
    const userLanguage = lang ?? options.lang
    const apply = (display: string, english: string, enabled: boolean) => {
      const presentation = event.metadata?.displayText
      event.prompt.text = display
      // Mentions refer to offsets in the submitted text, which rewriting invalidates.
      for (const attachment of [
        ...(event.prompt.files ?? []),
        ...(event.prompt.agents ?? []),
        ...(event.prompt.skills ?? []),
      ]) {
        delete attachment.mention
      }
      event.metadata = { ...event.metadata, [METADATA_KEY]: { lang: userLanguage, english, display, enabled } }
      // The Web UI prefers this field over prompt.text. Preserve its original
      // visible text (review comments may be rendered separately), then append
      // the same translation/notice that was added to the canonical prompt.
      if (typeof presentation === "string") {
        const visible = lang ? presentation : (stripTrigger(presentation, options.trigger) ?? presentation)
        event.metadata.displayText = `${visible}${display.slice(source.length)}`
      }
    }
    try {
      const english = await translator.text(source, userLanguage, LLM_LANGUAGE)
      const content = source === english ? source : `${source}\n\n→ EN: ${english}`
      const display = lang
        ? content
        : `${content}\n\n🌐 Translation enabled: ${userLanguage} ↔ ${LLM_LANGUAGE} (${options.model})`
      await state.remember(event.sessionID, display, english)
      await ctx.storage.set(`sessions/${event.sessionID}`, userLanguage)
      apply(display, english, true)
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] inbound translation failed; sending original text`, error)
      // The public Promise bridge may reject with a serialized tagged error,
      // rather than an Error instance from this module's JavaScript realm.
      const reason =
        error && typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message
          : String(error)
      const display = `${source}\n\n⚠️ Translation failed: ${reason}. Original text was sent to the model.`
      // Preserve v1's visible fallback and strip the control keyword. Failed
      // activation must not become an enabled session when metadata is recovered.
      apply(display, source, Boolean(lang))
    }
  })

  async function context(event: SessionRequest) {
    // Metadata identifies inbound text; exact stored records identify outbound trailers.
    // Never strip arbitrary Markdown that merely resembles a translation.
    event.messages = await Promise.all(
      event.messages.map(async (message) => {
        const inbound = readMetadata(message.metadata?.[METADATA_KEY])
        const content = await Promise.all(
          message.content.map(async (part) => {
            if (part.type === "tool-call" && part.name === "question") {
              const saved = await state.question(event.sessionID, part.id)
              if (typeof saved === "string") {
                const input: unknown = JSON.parse(saved)
                if (isQuestionArgs(input)) return { ...part, input }
              }
            }
            if (part.type !== "text") return part
            const text =
              inbound?.display === part.text ? inbound.english : await state.english(event.sessionID, part.text)
            return { ...part, text }
          }),
        )
        const metadata = { ...message.metadata }
        delete metadata[METADATA_KEY]
        return { ...message, content, metadata }
      }),
    )
  }
  await ctx.session.hook("context", context)
  await ctx.session.hook("title", context)
  // The pre-release v2 checkout (1.x app version) routes these through context.
  // Released v2 hosts dispatch separate hooks, as specified in the migration guide.
  if (Number.parseInt(ctx.app.version, 10) >= 2) {
    await ctx.session.hook("compaction", context)
    await ctx.session.hook("generate", context)
  }
  const clearQuestions = await registerQuestionHooks(ctx, state, translator)
  await requireHttpTransport(ctx)
  async function outbound(sessionID: string): Promise<ResponseTranslation | undefined> {
    const lang = await state.language(sessionID)
    if (!lang || lang === LLM_LANGUAGE) return
    return {
      lang,
      signal: controller.signal,
      translate: (text, signal) => translator.text(text, LLM_LANGUAGE, lang, signal),
      remember: (display, english) => state.remember(sessionID, display, english),
      warn: (message) => console.error(`[${PLUGIN_NAME}] ${message}`),
    }
  }
  const streaming = await registerModelTranslation(ctx, outbound)
  await ctx.session.hook("http.response", async (event) => {
    if (event.kind !== "primary" || !event.response.ok || streaming.has(event.sessionID)) return
    const translation = await outbound(event.sessionID)
    if (translation) event.response = translateResponse(event.request, event.response, translation)
  })
  return () => {
    controller.abort()
    clearQuestions()
  }
}

export function stripTrigger(text: string, keywords: string[]): string | undefined {
  const matches = keywords
    .flatMap((keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const match = new RegExp(`(^|\\s)${escaped}(?=$|\\s)`).exec(text)
      return match ? [{ keyword, offset: match.index + match[1].length }] : []
    })
    .sort((a, b) => a.offset - b.offset)
  const match = matches[0]
  if (!match) return
  return `${text.slice(0, match.offset)}${text.slice(match.offset + match.keyword.length).replace(/^ /, "")}`
}
