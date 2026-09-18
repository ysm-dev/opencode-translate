import { createHash } from "node:crypto"
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

// Every Console tier (Zen "opencode", Go "opencode-go", and whatever tier
// comes next) requires real OpenCode session metadata that ctx.generate.text()
// never sends. Known upfront from the configured provider ID -- not observed
// from a failure -- so these providers skip the stateless attempt entirely
// and go straight to the session path below. This is what actually makes the
// fallback robust: it does not depend on Console's error wording at all.
export function isSessionOnlyProvider(providerID: string): boolean {
  return providerID === "opencode" || providerID.startsWith("opencode-")
}

// Safety net for session-metadata requirements on providers isSessionOnlyProvider
// doesn't (yet) recognize. Console has worded this rejection differently by tier
// and release: the free Zen tier ("...free tier can only be used in/from within
// OpenCode.") and the paid Go tier ("Request is missing x-opencode-session and
// cannot be routed efficiently. Please see .../docs/go/#where-can-i-use-it.").
// Match on stable signals -- the literal header name, or the free-tier phrase --
// rather than either exact sentence, so wording drift keeps landing here even
// when it silently changes again.
export function isSessionMetadataRequired(message: string): boolean {
  return /free tier can only be used\b.*\bopencode/i.test(message) || /x-opencode-session/i.test(message)
}

// Both generation paths use the host's catalog, SQLite credentials and OAuth
// refresh. Session-only providers need the host's session request metadata too.
export function createTranslator(
  ctx: Plugin.Context,
  options: ResolvedTranslateOptions,
  signal: AbortSignal,
): Translator {
  const { providerID, modelID } = parseTranslatorModel(options.model)
  const model = { providerID, id: modelID, ...(options.variant ? { variant: options.variant } : {}) }
  let sessionRequired = isSessionOnlyProvider(providerID)
  let helper: Promise<string> | undefined

  function helperSession() {
    if (helper) return helper
    helper = (async () => {
      const key = `translator-session/${createHash("sha256")
        .update(
          JSON.stringify({ directory: ctx.location.directory, workspaceID: ctx.location.workspaceID ?? null, model }),
        )
        .digest("hex")}`
      const saved = await ctx.storage.get(key)
      // Session deletion is a normal user operation; recreate a missing helper.
      // Other failures should retain their actual error instead of creating sessions.
      const previous =
        typeof saved === "string"
          ? await ctx.session.get({ sessionID: saved }).catch((error: unknown) => {
              if (error && typeof error === "object" && "_tag" in error && /NotFound/.test(String(error._tag)))
                return undefined
              throw error
            })
          : undefined
      const session =
        previous ??
        (await ctx.session.create({
          title: `Translation helper (${options.model})`,
          model,
          location: {
            directory: ctx.location.directory,
            ...(ctx.location.workspaceID ? { workspaceID: ctx.location.workspaceID } : {}),
          },
          metadata: { "opencode-translate": { helper: true } },
        }))
      await ctx.storage.set(key, session.id)
      // Keep OpenCode's genuine system/request identity, including the real
      // tool definitions. Only the message history is trimmed to the current
      // translation prompt. Console's free-tier gateway silently rejects
      // "generate" requests whose tool list is emptied -- it reads as non-agent
      // traffic even with correct session headers -- so the definitions must
      // stay even though nothing on this path can execute a tool: generate()
      // never runs the tool loop, so an errant tool call just yields empty text.
      await ctx.session.hook(Number.parseInt(ctx.app.version, 10) >= 2 ? "generate" : "context", (event) => {
        if (event.sessionID !== session.id) return
        event.messages = event.messages.slice(-1)
      })
      return session.id
    })().catch((error: unknown) => {
      helper = undefined
      throw error
    })
    return helper
  }

  async function request(prompt: string, abort: AbortSignal) {
    if (!sessionRequired) {
      try {
        return await ctx.generate.text({ model, prompt }, { signal: abort })
      } catch (error) {
        const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error)
        // Reached only for providers isSessionOnlyProvider didn't flag upfront.
        // Use a real OpenCode session request rather than fabricating headers.
        if (!isSessionMetadataRequired(message)) throw error
        abort.throwIfAborted()
        sessionRequired = true
      }
    }
    const sessionID = await helperSession()
    abort.throwIfAborted()
    return ctx.session.generate({ sessionID, prompt }, { signal: abort })
  }

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
      const result = await Promise.race([request(prompt, abort), cancelled])
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
