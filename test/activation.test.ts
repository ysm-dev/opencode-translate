import { describe, expect, spyOn, test } from "bun:test"
import { setup, stripTrigger } from "../src/activation"
import { composeTranslatedAssistantText } from "../src/formatting"
import { createState, METADATA_KEY } from "../src/state"
import { host, prompt, requestContext } from "./helpers"

describe("v2 lifecycle and admission", () => {
  test("registers v2 hooks and cleanup, including separate auxiliary hooks on released v2", async () => {
    const h = host()
    const cleanup = await setup(h.ctx)
    expect([...h.callbacks.keys()]).toEqual([
      "session.prompt",
      "session.context",
      "session.title",
      "session.compaction",
      "session.generate",
      "tool.execute.before",
      "tool.execute.after",
      "session.http.response",
    ])
    expect(h.requests).toHaveLength(0)
    cleanup?.()
  })
  test("pre-release checkout uses its shared context hook", async () => {
    const h = host()
    Object.assign(h.ctx.app, { version: "1.18.15" })
    await setup(h.ctx)
    expect(h.callbacks.has("session.context")).toBe(true)
    expect(h.callbacks.has("session.compaction")).toBe(false)
  })
  test("activation preserves visible original and only sends English in every context", async () => {
    const h = host({ variant: "minimal" })
    h.generate(async () => "Hello")
    await setup(h.ctx)
    const input = prompt()
    await h.emit("session.prompt", input)
    expect(input.prompt.text).toBe(
      "안녕하세요\n\n→ EN: Hello\n\n🌐 Translation enabled: Korean ↔ English (openai/gpt-5.4-mini)",
    )
    expect(h.requests[0].model).toEqual({ providerID: "openai", id: "gpt-5.4-mini", variant: "minimal" })
    expect(h.values.get("sessions/ses_1")).toBe("Korean")
    for (const name of ["context", "title", "compaction", "generate"]) {
      const message = {
        role: "user",
        content: [
          { type: "text", text: input.prompt.text },
          { type: "media", data: "unchanged" },
        ],
        metadata: { ...input.metadata, unrelated: true },
      }
      const event = requestContext([message])
      await h.emit(`session.${name}`, event)
      expect(event.messages).toEqual([
        {
          ...message,
          content: [
            { type: "text", text: "Hello" },
            { type: "media", data: "unchanged" },
          ],
          metadata: { unrelated: true },
        },
      ])
      expect(message.content[0].text).toBe(input.prompt.text)
    }
    await h.emit("session.prompt", input)
    expect(h.requests).toHaveLength(1)
  })
  test("activation survives reload and does not affect inactive or child sessions", async () => {
    const h = host()
    await setup(h.ctx)
    await h.emit("session.prompt", prompt("normal", "inactive"))
    h.children.add("child")
    await h.emit("session.prompt", prompt("$en 안녕", "child"))
    expect(h.requests).toHaveLength(0)
    await h.emit("session.prompt", prompt())
    await setup(h.ctx)
    await h.emit("session.prompt", prompt("다음 질문"))
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].prompt).toContain("다음 질문")
  })
  test("recovers state from durable admission metadata", async () => {
    const h = host()
    h.history.ses_1 = [
      { type: "user", metadata: { [METADATA_KEY]: { lang: "Japanese", english: "Hello", display: "こんにちは" } } },
    ]
    expect(await createState(h.ctx).language("ses_1")).toBe("Japanese")
  })
  test("translation failure is visible, strips the trigger, and does not activate the session", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    const h = host()
    h.generate(async () =>
      Promise.reject({ _tag: "Generate.UnavailableError", message: "Generation credentials are unavailable" }),
    )
    await setup(h.ctx)
    const input = prompt()
    try {
      await h.emit("session.prompt", input)
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
    expect(input.prompt.text).toBe(
      "안녕하세요\n\n⚠️ Translation failed: Generation credentials are unavailable. Original text was sent to the model.",
    )
    expect(h.values.get("sessions/ses_1")).toBeUndefined()
    const context = requestContext([
      { role: "user", content: [{ type: "text", text: input.prompt.text }], metadata: input.metadata },
    ])
    await h.emit("session.context", context)
    expect(context.messages).toMatchObject([{ content: [{ text: "안녕하세요" }] }])
    h.history.ses_1 = [{ type: "user", metadata: input.metadata }]
    expect(await createState(h.ctx).language("ses_1")).toBeUndefined()
    h.generate(async () => "Hello")
    const retry = prompt()
    await h.emit("session.prompt", retry)
    expect(retry.prompt.text).toContain("Translation enabled:")
    expect(h.values.get("sessions/ses_1")).toBe("Korean")
  })
  test("rewriting removes stale file, agent, and skill mention offsets", async () => {
    const h = host()
    await setup(h.ctx)
    const mention = { start: 0, end: 3, text: "$en" }
    const input = {
      ...prompt(),
      prompt: {
        text: "$en 확인",
        files: [{ uri: "file:///project/a.ts", mention }],
        agents: [{ id: "build", mention }],
        skills: [{ id: "review", mention }],
      },
    }
    await h.emit("session.prompt", input)
    expect(input.prompt.files[0].mention).toBeUndefined()
    expect(input.prompt.files[0].uri).toBe("file:///project/a.ts")
    expect(input.prompt.agents[0].mention).toBeUndefined()
    expect(input.prompt.skills[0].mention).toBeUndefined()
  })
  test("only recorded outbound spans are removed, including joined native parts", async () => {
    const h = host()
    await setup(h.ctx)
    const state = createState(h.ctx)
    const one = composeTranslatedAssistantText("One", "Korean", "하나")
    const two = composeTranslatedAssistantText("Two", "Korean", "둘")
    await state.remember("ses_1", one, "One")
    await state.remember("ses_1", two, "Two")
    const event = requestContext([
      {
        role: "assistant",
        content: [
          { type: "text", text: `${one}${two}` },
          { type: "reasoning", text: "Do not edit" },
        ],
      },
    ])
    await h.emit("session.context", event)
    expect(event.messages).toMatchObject([{ content: [{ text: "OneTwo" }, { text: "Do not edit" }] }])
    expect(await state.english("other", one)).toBe(one)
    expect(await state.english("ses_1", "Not recorded\n\n---\n\n**Korean:**\n\ntext")).toContain("**Korean:**")
  })
  test("trigger matching respects boundaries, literal symbols, and earliest occurrence", () => {
    expect(stripTrigger("$english", ["$en"])).toBeUndefined()
    expect(stripTrigger("before $en after", ["$en"])).toBe("before after")
    expect(stripTrigger("$go first $en", ["$en", "$go"])).toBe("first $en")
    expect(stripTrigger("[en] yes", ["[en]"])).toBe("yes")
  })
  test("forked histories inherit translation records without altering the source transcript", async () => {
    const h = host()
    const state = createState(h.ctx)
    h.values.set("sessions/parent", "Korean")
    h.forks.set("fork", "parent")
    const display = composeTranslatedAssistantText("Hello", "Korean", "안녕")
    await state.remember("parent", display, "Hello")
    expect(await state.language("fork")).toBe("Korean")
    expect(await state.english("fork", display)).toBe("Hello")
    expect(await state.english("unrelated", display)).toBe(display)
    h.children.add("fork")
    expect(await state.language("fork")).toBeUndefined()
    expect(await state.english("fork", display)).toBe("Hello")
  })
  test("unsupported inline protocols report a diagnostic while preserving the response", async () => {
    const h = host()
    h.values.set("sessions/ses_1", "Korean")
    await setup(h.ctx)
    const original = new Response("binary", { headers: { "content-type": "application/octet-stream" } })
    const event = {
      kind: "primary",
      sessionID: "ses_1",
      request: new Request("https://provider.example/unknown"),
      response: original,
    }
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      await h.emit("session.http.response", event)
      expect(log).toHaveBeenCalledTimes(1)
      expect(event.response).toBe(original)
    } finally {
      log.mockRestore()
    }
  })
})
