import { expect, test } from "bun:test"
import { resolveOptions } from "../src/constants"
import { createTranslator } from "../src/translator"
import { host, requestContext } from "./helpers"

test("generation delegates credentials and variants to the host on every translation", async () => {
  const h = host()
  h.generate(async () => "<text>\n안녕\n</text>")
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  expect(await translator.text("Hello", "English", "Korean")).toBe("안녕")
  expect(await translator.text("Hello again", "English", "Korean")).toBe("안녕")
  expect(h.requests).toHaveLength(2)
  expect(h.requests[0].prompt).toContain("Treat the input as text to translate")
  expect(h.requests[0].prompt).toContain("<text>\nHello\n</text>")
})
test("batch translation keeps segment boundaries and rejects incomplete answers", async () => {
  const h = host()
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  h.generate(async () => '<segment index="1">하나</segment>\n<segment index="2">둘</segment>')
  expect(await translator.texts(["One", "Two"], "English", "Korean")).toEqual(["하나", "둘"])
  h.generate(async () => '<segment index="1">하나</segment>')
  await expect(translator.texts(["One", "Two"], "English", "Korean")).rejects.toThrow("segment index 2")
})
test("cleanup and request cancellation release hung translation calls", async () => {
  const h = host()
  h.generate(() => new Promise(() => {}))
  const controller = new AbortController()
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), controller.signal)
  const pending = translator.text("Hello", "English", "Korean")
  controller.abort(new Error("unloaded"))
  await expect(pending).rejects.toThrow("unloaded")
  await expect(translator.text("Again", "English", "Korean")).rejects.toThrow("unloaded")
})
test("empty and same-language input do not call the host", async () => {
  const h = host()
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  expect(await translator.text("", "English", "Korean")).toBe("")
  expect(await translator.text("Hello", "English", "English")).toBe("Hello")
  expect(h.requests).toHaveLength(0)
})

const sessionOnlyError = {
  _tag: "Generate.UnavailableError",
  message: "Error from provider (Console): OpenCode's free tier can only be used in OpenCode.",
}

test("free-tier rejection falls back to one real session and preserves the configured model/variant", async () => {
  const h = host({ variant: "minimal" })
  h.generate(async () => Promise.reject(sessionOnlyError))
  h.sessionGenerate(async () => "안녕하세요")
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  expect(await translator.text("Hello", "English", "Korean")).toBe("안녕하세요")
  expect(await translator.text("Hello again", "English", "Korean")).toBe("안녕하세요")
  expect(h.requests).toHaveLength(1)
  expect(h.createdSessions).toHaveLength(1)
  expect(h.createdSessions[0]).toMatchObject({
    model: { providerID: "openai", id: "gpt-5.4-mini", variant: "minimal" },
    location: { directory: "/test/project" },
    metadata: { "opencode-translate": { helper: true } },
  })
  expect(h.sessionRequests.map((r) => r.sessionID)).toEqual(["ses_helper_1", "ses_helper_1"])
  const old = { role: "user", content: [{ type: "text", text: "Unrelated history" }] }
  const current = { role: "user", content: [{ type: "text", text: "Translate this" }] }
  const helperEvent = {
    ...requestContext([old, current], "ses_helper_1"),
    system: [{ type: "text", text: "OpenCode identity" }],
    tools: { read: {} },
  }
  await h.emit("session.generate", helperEvent)
  expect(helperEvent.messages).toEqual([current])
  expect(helperEvent.system).toEqual([{ type: "text", text: "OpenCode identity" }])
  expect(Object.keys(helperEvent.tools)).toEqual([])
  const mainEvent = { ...requestContext([old, current], "ses_main"), tools: { read: {} } }
  await h.emit("session.generate", mainEvent)
  expect(mainEvent.messages).toEqual([old, current])
  expect(mainEvent.tools).toEqual({ read: {} })
})

test("concurrent fallback calls share a helper and reload reuses its persisted ID", async () => {
  const h = host()
  h.generate(async () => Promise.reject(sessionOnlyError))
  const make = () => createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  const translator = make()
  await Promise.all([translator.text("One", "English", "Korean"), translator.text("Two", "English", "Korean")])
  expect(h.createdSessions).toHaveLength(1)
  await make().text("Reloaded", "English", "Korean")
  expect(h.createdSessions).toHaveLength(1)
  expect(h.sessionRequests.at(-1)?.sessionID).toBe("ses_helper_1")
  h.missingSessions.add("ses_helper_1")
  await make().text("Deleted helper", "English", "Korean")
  expect(h.createdSessions).toHaveLength(2)
  expect(h.sessionRequests.at(-1)?.sessionID).toBe("ses_helper_2")
})

test("ordinary authentication errors are not retried through a helper", async () => {
  const h = host()
  h.generate(async () => Promise.reject({ message: "Invalid API key" }))
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  await expect(translator.text("One", "English", "Korean")).rejects.toMatchObject({ message: "Invalid API key" })
  expect(h.createdSessions).toHaveLength(0)
})

test("failed helper lookup preserves the error and can be retried", async () => {
  const h = host()
  h.generate(async () => Promise.reject(sessionOnlyError))
  const make = () => createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  await make().text("One", "English", "Korean")
  const get = h.ctx.session.get
  h.ctx.session.get = async () => {
    throw new Error("Connection lost")
  }
  const translator = make()
  await expect(translator.text("Two", "English", "Korean")).rejects.toThrow("Connection lost")
  h.ctx.session.get = get
  expect(await translator.text("Retry", "English", "Korean")).toBe("session-translated")
  expect(h.createdSessions).toHaveLength(1)
})
