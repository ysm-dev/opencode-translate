import { composeTranslatedAssistantText, composeTranslationFailureText } from "./formatting"
import { getDisplayLanguageLabel } from "./labels"
import { createAdapter, type Protocol } from "./response/protocols"

export interface ResponseTranslation {
  lang: string
  signal: AbortSignal
  translate(text: string, signal: AbortSignal): Promise<string>
  remember(display: string, english: string): Promise<void>
  warn(message: string): void
}

function protocolFor(request: Request): Protocol | undefined {
  const path = new URL(request.url).pathname
  if (/\/responses\/?$/.test(path)) return "responses"
  if (/\/chat\/completions\/?$/.test(path)) return "chat"
  if (/\/messages\/?$/.test(path)) return "anthropic"
  if (/:streamGenerateContent$/.test(path)) return "gemini"
}

// Modify only recognized SSE text protocols. Binary Bedrock, images, and custom
// protocols stay byte-for-byte untouched rather than guessing their wire format.
export function translateResponse(request: Request, response: Response, options: ResponseTranslation): Response {
  const protocol = protocolFor(request)
  if (!protocol || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    options.warn("Inline translation unavailable for this response protocol; preserving English output")
    return response
  }
  const cancelled = new AbortController()
  const signal = AbortSignal.any([options.signal, request.signal, cancelled.signal])
  const reader = response.body.getReader()
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const adapter = createAdapter(protocol, async (english) => {
    if (!english.trim()) return english
    signal.throwIfAborted()
    let display: string
    try {
      const translated = await options.translate(english, signal)
      if (!translated.trim()) throw new Error("Translator returned empty text")
      display = composeTranslatedAssistantText(english, getDisplayLanguageLabel(options.lang), translated)
    } catch (error) {
      signal.throwIfAborted()
      options.warn(`Outbound translation failed: ${String(error)}`)
      display = composeTranslationFailureText(english)
    }
    // Commit provenance before emitting any trailer. If storage fails, do not
    // introduce text that a future model request could not remove.
    try {
      await options.remember(display, english)
    } catch (error) {
      options.warn(`Cannot save translation history: ${String(error)}`)
      return english
    }
    return display
  })
  async function* frames() {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        signal.throwIfAborted()
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        let boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
        while (boundary) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          for (const output of await adapter(frame)) yield `${output}\n\n`
          boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
        }
        if (done) {
          // An unterminated frame is an incomplete provider stream, not a text
          // completion. Preserve it without manufacturing a successful finish.
          if (buffer) yield buffer
          break
        }
      }
    } finally {
      signal.removeEventListener("abort", abort)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const iterator = frames()
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled.abort(reason)
      await iterator.return(undefined)
    },
  })
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.delete("etag")
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
