import type { Plugin } from "@opencode/plugin"
import type { AISDKHooks } from "@opencode/plugin/promise/aisdk"
import { type ResponseTranslation, translateSegment } from "./response"

type LanguageModel = NonNullable<AISDKHooks["language"]["language"]>
type CallOptions = Parameters<LanguageModel["doStream"]>[0]
type StreamPart =
  Awaited<ReturnType<LanguageModel["doStream"]>>["stream"] extends ReadableStream<infer Part> ? Part : never

// Tags a primary request with its session. It never leaves OpenCode: the model
// wrapper removes it from AI SDK calls and the http.request hook from native requests.
const SESSION_HEADER = "x-opencode-translate-session"
const ignoreError = () => undefined

function isLanguageModel(value: unknown): value is LanguageModel {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "doStream") === "function"
}

function untag(options: CallOptions) {
  const headers = { ...options.headers }
  let sessionID: string | undefined
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== SESSION_HEADER) continue
    sessionID = headers[name]
    delete headers[name]
  }
  return { sessionID, forwarded: sessionID === undefined ? options : { ...options, headers } }
}

// Provider plugins can build their AI SDK client with their own fetch, which
// bypasses the HTTP hooks (oc-codex-multi-auth does this for `openai`). Replies
// from those models are translated from their stream parts instead. Returns the
// sessions whose current reply is handled here, so HTTP translation can skip them.
export async function registerModelTranslation(
  ctx: Plugin.Context,
  outbound: (sessionID: string) => Promise<ResponseTranslation | undefined>,
) {
  const streaming = new Set<string>()
  const wrapped = new WeakMap<LanguageModel, LanguageModel>()

  async function doStream(model: LanguageModel, options: CallOptions) {
    const { sessionID, forwarded } = untag(options)
    if (sessionID === undefined) return model.doStream(forwarded)
    streaming.add(sessionID)
    try {
      const [translation, result] = await Promise.all([
        outbound(sessionID).catch(ignoreError),
        model.doStream(forwarded),
      ])
      if (!translation || translation.signal.aborted) return result
      return { ...result, stream: translateStream(result.stream, translation, options.abortSignal) }
    } finally {
      streaming.delete(sessionID)
    }
  }

  function wrap(model: LanguageModel) {
    let proxy = wrapped.get(model)
    if (!proxy) {
      proxy = new Proxy(model, {
        get(target, property) {
          if (property === "doStream") return (options: CallOptions) => doStream(target, options)
          if (property === "doGenerate") return (options: CallOptions) => target.doGenerate(untag(options).forwarded)
          const value: unknown = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      wrapped.set(model, proxy)
    }
    return proxy
  }

  // OpenCode passes each plugin a copy of the language event and keeps the last
  // model set, so a plugin loaded after this one may still build the model from
  // the shared SDK (oc-codex-multi-auth does). Wrap the models it creates too.
  const instrumented = new WeakSet<object>()
  function instrument(sdk: unknown) {
    if (!sdk || (typeof sdk !== "object" && typeof sdk !== "function") || instrumented.has(sdk)) return
    instrumented.add(sdk)
    for (const name of Object.keys(sdk)) {
      const create: unknown = Reflect.get(sdk, name)
      if (typeof create !== "function") continue
      Reflect.set(sdk, name, (...args: unknown[]) => {
        const created: unknown = Reflect.apply(create, sdk, args)
        return isLanguageModel(created) ? wrap(created) : created
      })
    }
  }

  await ctx.session.hook("model.request", (event) => {
    if (event.kind === "primary") event.headers[SESSION_HEADER] = event.sessionID
  })
  await ctx.session.hook("http.request", (event) => {
    event.request.headers.delete(SESSION_HEADER)
  })
  await ctx.aisdk.hook("language", (event) => {
    instrument(event.sdk)
    if (event.language) event.language = wrap(event.language)
  })
  return streaming
}

function translateStream(
  stream: ReadableStream<StreamPart>,
  translation: ResponseTranslation,
  requestSignal?: AbortSignal,
) {
  const cancelled = new AbortController()
  const signal = AbortSignal.any([translation.signal, cancelled.signal, ...(requestSignal ? [requestSignal] : [])])
  const reader = stream.getReader()
  const abort = () => {
    void reader.cancel(signal.reason).catch(ignoreError)
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const release = () => {
    signal.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  const texts = new Map<string, string>()
  return new ReadableStream<StreamPart>({
    async pull(controller) {
      try {
        signal.throwIfAborted()
        const next = await reader.read()
        signal.throwIfAborted()
        if (next.done) {
          release()
          controller.close()
          return
        }
        const part = next.value
        if (part.type === "text-start") texts.set(part.id, "")
        if (part.type === "text-delta") texts.set(part.id, `${texts.get(part.id) ?? ""}${part.delta}`)
        if (part.type === "text-end") {
          const english = texts.get(part.id) ?? ""
          texts.delete(part.id)
          // Emit the trailer inside the text part, before it closes.
          const display = await translateSegment(english, translation, signal)
          if (display.length > english.length)
            controller.enqueue({ type: "text-delta", id: part.id, delta: display.slice(english.length) })
        }
        controller.enqueue(part)
      } catch (error) {
        await reader.cancel(error).catch(ignoreError)
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled.abort(reason)
      await reader.cancel(reason).catch(ignoreError)
      release()
    },
  })
}
