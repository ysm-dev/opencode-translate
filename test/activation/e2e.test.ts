import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import type { MessageWithPartsLike, PluginClientLike, TextPartLike } from "../../src/constants"
import { composeTranslatedAssistantText, composeTranslationFailureText } from "../../src/formatting"
import { activeStateMetadata, textPart } from "../translator/helpers"

function makeClient(storedMessages: MessageWithPartsLike[], logs: string[] = []): PluginClientLike {
  const assistantMessage: MessageWithPartsLike = {
    info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
    parts: [textPart("assistant", "Done")],
  }

  return {
    session: {
      get: async () => ({ data: { id: "ses_1", parentID: null } }),
      messages: async () => ({ data: storedMessages }),
      message: async () => ({ data: assistantMessage }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    auth: { set: async () => ({ data: {} }) },
    app: {
      log: async (input) => {
        logs.push(input.body.message)
        return { data: {} }
      },
    },
  }
}

describe("translation hook E2E flow", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
  })

  test("activates, transforms history, translates assistant text, and restores question output", async () => {
    const storedMessages: MessageWithPartsLike[] = []
    const calls: string[] = []
    const hooks = createHooks(
      { client: makeClient(storedMessages), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean", assistantTranslation: "each-part" },
      {
        translator: {
          translateText: async ({ text, direction }) => {
            calls.push(`${direction}:${text}`)
            return direction === "inbound" ? `EN:${text}` : `KO:${text}`
          },
        },
      },
    )

    const chatOutput = { message: { id: "msg_user" }, parts: [textPart("p1", "$en 안녕")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, chatOutput as never)

    expect((chatOutput.parts[0] as TextPartLike).text).toContain("안녕\n\n→ EN: EN:안녕")
    expect((chatOutput.parts[1] as TextPartLike).text).toBe("EN:안녕")
    expect((chatOutput.parts[2] as TextPartLike).metadata?.translate_role).toBe("activation_banner")

    const transformOutput = {
      messages: [
        { info: { id: "msg_user", sessionID: "ses_1", role: "user" }, parts: chatOutput.parts },
        {
          info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
          parts: [
            textPart("a1", composeTranslatedAssistantText("English answer", "Translation (Korean)", "한국어 답변")),
            { ...textPart("file", "ignored"), type: "file" },
          ],
        },
        { info: { id: "msg_tool", sessionID: "ses_1", role: "tool" }, parts: [textPart("tool", "tool output")] },
      ],
    }

    await hooks["experimental.chat.messages.transform"]!({} as never, transformOutput as never)

    expect((transformOutput.messages[0].parts[0] as TextPartLike).ignored).toBe(true)
    expect((transformOutput.messages[0].parts[1] as TextPartLike).text).toBe("EN:안녕")
    expect((transformOutput.messages[1].parts[0] as TextPartLike).text).toBe("English answer")
    expect((transformOutput.messages[2].parts[0] as TextPartLike).text).toBe("tool output")

    const completeOutput = { text: "English follow-up" }
    await hooks["experimental.text.complete"]!(
      { sessionID: "ses_1", messageID: "msg_assistant" } as never,
      completeOutput,
    )
    expect(completeOutput.text).toContain("English follow-up")
    expect(completeOutput.text).toContain("KO:English follow-up")

    const args = {
      questions: [
        {
          question: "Proceed?",
          header: "Confirm",
          options: [{ label: "Yes", description: "Continue" }],
          custom: true,
        },
      ],
    }
    await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_e2e" }, { args } as never)
    expect(args.questions[0].question).toBe("KO:Proceed?")

    const questionOutput = {
      output: `User has answered your questions: "KO:Proceed?"="직접 답변". You can now continue with the user's answers in mind.`,
      metadata: { answers: [["직접 답변"]] },
    }
    await hooks["tool.execute.after"]!(
      { tool: "question", sessionID: "ses_1", callID: "call_e2e", args } as never,
      questionOutput as never,
    )

    expect(questionOutput.output).toContain('"Proceed?"="EN:직접 답변"')
    expect(calls).toEqual([
      "inbound:안녕",
      "outbound:English follow-up",
      "outbound:Proceed?",
      "outbound:Confirm",
      "outbound:Yes",
      "outbound:Continue",
      "inbound:직접 답변",
    ])
  })

  test("assistant completion failures append the failure trailer and log the error", async () => {
    const logs: string[] = []
    const storedMessages = [
      {
        info: { id: "msg_banner", sessionID: "ses_1", role: "user" },
        parts: [textPart("banner", "banner", { metadata: activeStateMetadata("banner") })],
      },
    ]
    const hooks = createHooks(
      { client: makeClient(storedMessages, logs), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean", assistantTranslation: "each-part" },
      {
        translator: {
          translateText: async () => {
            throw new Error("outbound translator unavailable")
          },
        },
      },
    )
    const output = { text: "English text" }

    await hooks["experimental.text.complete"]!({ sessionID: "ses_1", messageID: "msg_assistant" } as never, output)

    expect(output.text).toBe(composeTranslationFailureText("English text"))
    expect(logs).toEqual(["outbound translator unavailable"])
  })

  test("final-message mode translates only the last assistant text part after session idle", async () => {
    const storedMessages: MessageWithPartsLike[] = []
    const calls: string[] = []
    const updates: TextPartLike[] = []
    const client = {
      ...makeClient(storedMessages),
      part: {
        update: async ({ part }: { part?: TextPartLike }) => {
          if (!part) throw new Error("missing part")
          updates.push(part)
          for (const message of storedMessages) {
            const index = message.parts.findIndex((candidate) => candidate.id === part.id)
            if (index >= 0) message.parts[index] = part
          }
          return { data: part }
        },
      },
    } satisfies PluginClientLike
    const hooks = createHooks(
      { client, directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text, direction }) => {
            calls.push(`${direction}:${text}`)
            return direction === "inbound" ? `EN:${text}` : `KO:${text}`
          },
        },
      },
    )

    const chatOutput = { message: { id: "msg_user" }, parts: [textPart("p1", "$en 안녕")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, chatOutput as never)
    const completeOutput = { text: "Intermediate assistant text" }
    await hooks["experimental.text.complete"]!(
      { sessionID: "ses_1", messageID: "msg_assistant", partID: "a1" } as never,
      completeOutput,
    )

    expect(completeOutput.text).toBe("Intermediate assistant text")
    expect(calls).toEqual(["inbound:안녕"])

    const assistantMessage: MessageWithPartsLike = {
      info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
      parts: [
        textPart("a1", "Intermediate assistant text", { messageID: "msg_assistant" }),
        { ...textPart("tool", "not text", { messageID: "msg_assistant" }), type: "tool" },
        textPart("a2", "Final assistant text", { messageID: "msg_assistant" }),
      ],
    }
    storedMessages.splice(0, storedMessages.length, assistantMessage)

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)

    expect(calls).toEqual(["inbound:안녕", "outbound:Final assistant text"])
    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe("a2")
    expect(assistantMessage.parts[0].text).toBe("Intermediate assistant text")
    expect(assistantMessage.parts[2].text).toBe(
      composeTranslatedAssistantText("Final assistant text", "Translation (Korean)", "KO:Final assistant text"),
    )

    const transformOutput = { messages: [assistantMessage] }
    await hooks["experimental.chat.messages.transform"]!({} as never, transformOutput as never)
    expect((transformOutput.messages[0].parts[0] as TextPartLike).text).toBe("Intermediate assistant text")
    expect((transformOutput.messages[0].parts[2] as TextPartLike).text).toBe("Final assistant text")
  })

  test("final-message mode can update the final part through the server PATCH fallback", async () => {
    const storedMessages: MessageWithPartsLike[] = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [textPart("user", "안녕", { metadata: activeStateMetadata("안녕") })],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
        parts: [textPart("a1", "Final text", { messageID: "msg_assistant" })],
      },
    ]
    const requests: { url: string; init?: RequestInit }[] = []
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    const hooks = createHooks(
      {
        client: makeClient(storedMessages),
        directory: "/workspace",
        serverUrl: new URL("https://opencode.test"),
      } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => `KO:${text}`,
        },
      },
    )

    try {
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(
      "https://opencode.test/session/ses_1/message/msg_assistant/part/a1?directory=%2Fworkspace",
    )
    expect(requests[0].init?.method).toBe("PATCH")
    expect(JSON.parse(String(requests[0].init?.body)).text).toBe(
      composeTranslatedAssistantText("Final text", "Translation (Korean)", "KO:Final text"),
    )
  })

  test("final-message mode logs server PATCH failures", async () => {
    const logs: string[] = []
    const storedMessages: MessageWithPartsLike[] = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [textPart("user", "안녕", { metadata: activeStateMetadata("안녕") })],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
        parts: [textPart("a1", "Final text", { messageID: "msg_assistant" })],
      },
    ]
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch
    const hooks = createHooks(
      {
        client: makeClient(storedMessages, logs),
        directory: "/workspace",
        serverUrl: new URL("https://opencode.test"),
      } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => `KO:${text}`,
        },
      },
    )

    try {
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(logs).toEqual(["Failed to update final assistant translation part: HTTP 500"])
  })

  test("final-message mode stores a failure trailer when outbound translation fails", async () => {
    const logs: string[] = []
    const storedMessages: MessageWithPartsLike[] = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [textPart("user", "안녕", { metadata: activeStateMetadata("안녕") })],
      },
      {
        info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
        parts: [textPart("a1", "Final text", { messageID: "msg_assistant" })],
      },
    ]
    const updates: TextPartLike[] = []
    const client = {
      ...makeClient(storedMessages, logs),
      part: {
        update: async ({ part }: { part?: TextPartLike }) => {
          if (!part) throw new Error("missing part")
          updates.push(part)
          return { data: part }
        },
      },
    } satisfies PluginClientLike
    const hooks = createHooks(
      { client, directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async () => {
            throw new Error("outbound translator unavailable")
          },
        },
      },
    )

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)

    expect(updates[0].text).toBe(composeTranslationFailureText("Final text"))
    expect(logs).toEqual(["outbound translator unavailable"])
  })

  test("final-message mode ignores idle events without a final assistant text", async () => {
    const storedMessages: MessageWithPartsLike[] = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [textPart("user", "안녕", { metadata: activeStateMetadata("안녕") })],
      },
    ]
    let calls = 0
    const hooks = createHooks(
      { client: makeClient(storedMessages), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async () => {
            calls += 1
            return "unused"
          },
        },
      },
    )

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)

    storedMessages.push({
      info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
      parts: [{ ...textPart("tool", "not text", { messageID: "msg_assistant" }), type: "tool" }],
    })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as never)

    expect(calls).toBe(0)
  })
})
