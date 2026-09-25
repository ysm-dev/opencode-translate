import { describe, expect, test } from "bun:test"
import { setup } from "../src/activation"
import { createState } from "../src/state"
import { host } from "./helpers"

const TAG = "x-opencode-translate-session"
const TRAILER = "\n\n---\n\n**Translation (Korean):**\n\n안녕하세요"

interface Part {
  type: string
  id?: string
  delta?: string
}
interface Options {
  abortSignal?: AbortSignal
  headers?: Record<string, string | undefined>
  providerOptions?: Record<string, unknown>
}
interface Model {
  modelId: string
  info(): string
  doGenerate(options: Options): Promise<{ text: string }>
  doStream(options: Options): Promise<{ stream: ReadableStream<Part> }>
}
interface LanguageEvent {
  model: { id: string; providerID: string; modelID: string }
  options: Record<string, unknown>
  sdk: SDK
  language?: Model
}
type SDK = ((id: string) => Model) & { languageModel(id: string): Model; responses(id: string): Model }
type Hook = (event: LanguageEvent) => unknown

const reply: Part[] = [
  { type: "stream-start" },
  { type: "reasoning-start", id: "r1" },
  { type: "reasoning-delta", id: "r1", delta: "Thinking" },
  { type: "reasoning-end", id: "r1" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Hel" },
  { type: "text-delta", id: "t1", delta: "lo" },
  { type: "text-end", id: "t1" },
  { type: "finish" },
]

// An AI SDK provider whose requests never pass through OpenCode's HTTP hooks.
function providerSDK(
  during?: () => Promise<void>,
  source?: {
    pull?(controller: ReadableStreamDefaultController<Part>): void
    cancel?(reason: unknown): void
  },
) {
  const calls: Options[] = []
  const create = (): Model => ({
    modelId: "main",
    info() {
      return this.modelId
    },
    async doGenerate(options) {
      calls.push(options)
      return { text: "Hello" }
    },
    async doStream(options) {
      calls.push(options)
      await during?.()
      return {
        stream: new ReadableStream<Part>(
          source ?? {
            start(controller: ReadableStreamDefaultController<Part>) {
              for (const part of reply) controller.enqueue(part)
              controller.close()
            },
          },
        ),
      }
    },
  })
  const sdk: SDK = Object.assign((_id: string) => create(), {
    languageModel: (_id: string) => create(),
    responses: (_id: string) => create(),
  })
  return { sdk, calls }
}

// oc-codex-multi-auth@6.24.0: builds its model from the SDK in its own language hook.
const multiAuth: Hook = (event) => {
  const model = event.sdk.responses(event.model.modelID)
  event.language = new Proxy(model, {
    get(target, property, receiver) {
      if (property === "doStream")
        return (options: Options) =>
          target.doStream({ ...options, providerOptions: { ...options.providerOptions, openai: { store: false } } })
      return Reflect.get(target, property, receiver)
    },
  })
}

// Mirrors OpenCode 2.0.16: each plugin gets a copy of the event, and the last model set wins.
async function resolveLanguage(hooks: Hook[], sdk: SDK) {
  const shared: LanguageEvent = { model: { id: "main", providerID: "openai", modelID: "main" }, options: {}, sdk }
  for (const hook of hooks) {
    const copy = { ...shared }
    await hook(copy)
    shared.language = copy.language
  }
  return shared.language ?? sdk.languageModel("main")
}

async function collect(stream: ReadableStream<Part>) {
  const parts: Part[] = []
  for await (const part of stream) parts.push(part)
  return parts
}

function text(parts: Part[]) {
  return parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
}

async function translatedHost() {
  const h = host()
  h.values.set("sessions/ses_1", "Korean")
  h.generate(async () => "안녕하세요")
  await setup(h.ctx)
  const ours: Hook = (event) => h.emit("aisdk.language", event)
  return { ...h, ours }
}

describe("AI SDK models that bypass OpenCode's HTTP hooks", () => {
  test("only primary requests are tagged, and the tag is removed from native HTTP requests", async () => {
    const h = await translatedHost()
    const primary = { kind: "primary", sessionID: "ses_1", headers: {} as Record<string, string> }
    const title = { kind: "title", sessionID: "ses_1", headers: {} as Record<string, string> }
    await h.emit("session.model.request", primary)
    await h.emit("session.model.request", title)
    expect(primary.headers[TAG]).toBe("ses_1")
    expect(title.headers).toEqual({})
    const request = new Request("https://api.example/v1/responses", { headers: { [TAG]: "ses_1", other: "kept" } })
    await h.emit("session.http.request", { kind: "primary", sessionID: "ses_1", request })
    expect(request.headers.has(TAG)).toBe(false)
    expect(request.headers.get("other")).toBe("kept")
  })

  test("a provider plugin loaded after this one is translated, and the tag is never sent", async () => {
    const h = await translatedHost()
    const provider = providerSDK()
    const model = await resolveLanguage([h.ours, multiAuth], provider.sdk)
    const parts = await collect((await model.doStream({ headers: { [TAG]: "ses_1", other: "kept" } })).stream)
    expect(provider.calls[0].headers).toEqual({ other: "kept" })
    expect(provider.calls[0].providerOptions).toEqual({ openai: { store: false } })
    expect(text(parts)).toBe(`Hello${TRAILER}`)
    // The trailer is emitted inside the text part, before it closes.
    expect(parts.slice(-3)).toEqual([
      { type: "text-delta", id: "t1", delta: TRAILER },
      { type: "text-end", id: "t1" },
      { type: "finish" },
    ])
    expect(parts.filter((part) => part.type.startsWith("reasoning"))).toEqual(reply.slice(1, 4))
    expect(await createState(h.ctx).english("ses_1", `Hello${TRAILER}`)).toBe("Hello")
  })

  test("a provider plugin loaded before this one, or OpenCode's default model, is translated too", async () => {
    for (const hooks of [(ours: Hook) => [multiAuth, ours], (ours: Hook) => [ours]]) {
      const h = await translatedHost()
      const model = await resolveLanguage(hooks(h.ours), providerSDK().sdk)
      expect(text(await collect((await model.doStream({ headers: { [TAG]: "ses_1" } })).stream))).toBe(
        `Hello${TRAILER}`,
      )
    }
  })

  test("untagged calls and inactive sessions pass through untouched", async () => {
    const h = await translatedHost()
    const provider = providerSDK()
    const model = await resolveLanguage([h.ours, multiAuth], provider.sdk)
    expect(text(await collect((await model.doStream({ headers: { other: "kept" } })).stream))).toBe("Hello")
    expect(provider.calls[0].headers).toEqual({ other: "kept" })
    const inactive = await model.doStream({ headers: { [TAG]: "ses_other" } })
    expect(provider.calls[1].headers).toEqual({})
    expect(text(await collect(inactive.stream))).toBe("Hello")
    expect(h.requests).toHaveLength(0)
  })

  test("HTTP translation leaves replies the wrapper already translates alone", async () => {
    const h = await translatedHost()
    const response = new Response('data: {"type":"response.output_text.delta"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    })
    const http = {
      kind: "primary",
      sessionID: "ses_1",
      request: new Request("https://api.example/v1/responses"),
      response,
    }
    const provider = providerSDK(() => h.emit("session.http.response", http))
    const model = await resolveLanguage([h.ours], provider.sdk)
    const result = await model.doStream({ headers: { [TAG]: "ses_1" } })
    expect(http.response).toBe(response)
    expect(text(await collect(result.stream))).toBe(`Hello${TRAILER}`)
  })

  test("models wrapped more than once are still translated only once", async () => {
    const h = await translatedHost()
    const again: Hook = (event) => {
      const inner = event.language
      if (inner) event.language = { ...inner, doStream: (options) => inner.doStream(options) }
    }
    const model = await resolveLanguage([h.ours, multiAuth, h.ours, again], providerSDK().sdk)
    expect(text(await collect((await model.doStream({ headers: { [TAG]: "ses_1" } })).stream))).toBe(`Hello${TRAILER}`)
    expect(h.requests).toHaveLength(1)
  })

  test("stream read failures propagate and release the upstream reader", async () => {
    const h = await translatedHost()
    const failure = new Error("provider stream broke")
    const provider = providerSDK(undefined, {
      pull(controller) {
        controller.error(failure)
      },
    })
    const model = await resolveLanguage([h.ours], provider.sdk)
    const result = await model.doStream({ headers: { [TAG]: "ses_1" } })
    await expect(collect(result.stream)).rejects.toBe(failure)
    expect(h.requests).toHaveLength(0)
  })

  test("consumer cancellation cancels the provider stream", async () => {
    const h = await translatedHost()
    let reason: unknown
    const provider = providerSDK(undefined, {
      pull(controller) {
        controller.enqueue({ type: "text-delta", id: "t1", delta: "Hello" })
      },
      cancel(value) {
        reason = value
      },
    })
    const model = await resolveLanguage([h.ours], provider.sdk)
    const result = await model.doStream({ headers: { [TAG]: "ses_1" } })
    const reader = result.stream.getReader()
    await reader.read()
    await reader.cancel("user stopped")
    expect(reason).toBe("user stopped")
    expect(h.requests).toHaveLength(0)
  })

  test("request abort cancels a pending provider read", async () => {
    const h = await translatedHost()
    let reason: unknown
    const provider = providerSDK(undefined, {
      cancel(value) {
        reason = value
      },
    })
    const model = await resolveLanguage([h.ours], provider.sdk)
    const abort = new AbortController()
    const result = await model.doStream({ headers: { [TAG]: "ses_1" }, abortSignal: abort.signal })
    const failure = new Error("request stopped")
    const read = result.stream.getReader().read()
    abort.abort(failure)
    await expect(read).rejects.toBe(failure)
    expect(reason).toBe(failure)
  })

  test("non-stream generation removes internal tags and retains bound model methods", async () => {
    const h = await translatedHost()
    const provider = providerSDK()
    const model = await resolveLanguage([h.ours], provider.sdk)
    expect(model.info()).toBe("main")
    expect(await model.doGenerate({ headers: { [TAG]: "ses_1", other: "kept" } })).toEqual({ text: "Hello" })
    expect(provider.calls[0].headers).toEqual({ other: "kept" })
    expect(h.requests).toHaveLength(0)
  })
})
