import type { Plugin } from "@opencode/plugin"
import { PLUGIN_NAME, parseTranslatorModel, type ResolvedTranslateOptions } from "./constants"
import {
  buildBatchSystemPrompt,
  buildBatchUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  parseBatchSegments,
  unwrapEchoedTextEnvelope,
} from "./prompts"

export interface Translator {
  text(text: string, sourceLanguage: string, targetLanguage: string, signal?: AbortSignal): Promise<string>
  texts(texts: readonly string[], sourceLanguage: string, targetLanguage: string): Promise<string[]>
}

// Stateless generation uses the host's catalog, SQLite credentials and OAuth refresh.
// It does not enter the session hooks and cannot recursively translate itself.
export function createTranslator(
  ctx: Plugin.Context,
  options: ResolvedTranslateOptions,
  signal: AbortSignal,
): Translator {
  const { providerID, modelID } = parseTranslatorModel(options.model)
  const model = { providerID, id: modelID, ...(options.variant ? { variant: options.variant } : {}) }
  async function generate(prompt: string, requestSignal?: AbortSignal) {
    const started = Date.now()
    const abort = AbortSignal.any([signal, AbortSignal.timeout(180_000), ...(requestSignal ? [requestSignal] : [])])
    abort.throwIfAborted()
    // Some older in-process hosts do not forward RequestOptions.signal. Race it as well
    // so interruption always releases the primary response, even on those hosts.
    let rejectCancelled: (reason: unknown) => void
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = reject
    })
    const stop = () => rejectCancelled(abort.reason)
    abort.addEventListener("abort", stop, { once: true })
    try {
      const result = await Promise.race([ctx.generate.text({ model, prompt }, { signal: abort }), cancelled])
      if (options.verbose)
        console.info(`[${PLUGIN_NAME}] translated with ${options.model} in ${Date.now() - started}ms`)
      return result.text
    } finally {
      abort.removeEventListener("abort", stop)
    }
  }
  return {
    async text(text, sourceLanguage, targetLanguage, requestSignal) {
      if (!text || sourceLanguage === targetLanguage) return text
      const input = { text, sourceLanguage, targetLanguage }
      const translated = unwrapEchoedTextEnvelope(
        await generate(`${buildSystemPrompt(input)}\n\n${buildUserPrompt(input)}`, requestSignal),
      )
      if (!translated.trim()) throw new Error("Translator returned empty text")
      return translated
    },
    async texts(texts, sourceLanguage, targetLanguage) {
      if (!texts.length || sourceLanguage === targetLanguage) return [...texts]
      const input = { texts, sourceLanguage, targetLanguage }
      const result = await generate(`${buildBatchSystemPrompt(input)}\n\n${buildBatchUserPrompt(input)}`)
      return parseBatchSegments(result, texts.length).map((text, index) => {
        const translated = unwrapEchoedTextEnvelope(text)
        if (texts[index].trim() && !translated.trim()) throw new Error("Translator returned an empty segment")
        return translated
      })
    },
  }
}
