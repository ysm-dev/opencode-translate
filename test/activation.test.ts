import { beforeEach, describe, expect, test } from "bun:test"
import {
  __resetActivationCacheForTest,
  createHooks,
  extractStoredState,
  findTriggerMatch,
  stripTriggerKeyword,
} from "../src/activation"
import type { MessageWithPartsLike, PluginClientLike, TextPartLike, TranslateState } from "../src/constants"
import { hashText } from "../src/translator"

function textPart(id: string, text: string, extra: Partial<TextPartLike> = {}): TextPartLike {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_new",
    type: "text",
    text,
    ...extra,
  }
}

function filePart(id = "file_1"): TextPartLike {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_new",
    type: "file",
  }
}

function makeState(): TranslateState {
  return {
    translate_enabled: true,
    translate_source_lang: "ko",
    translate_display_lang: "ko",
    translate_llm_lang: "en",
    translate_nonce: "0123456789abcdef0123456789abcdef",
  }
}

function storedMessage(parts: TextPartLike[], role = "user"): MessageWithPartsLike {
  return {
    info: {
      id: `msg_${role}`,
      sessionID: "ses_1",
      role,
    },
    parts,
  }
}

function fakeClient(storedMessages: MessageWithPartsLike[], parentID: string | null = null): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID }),
      messages: async () => storedMessages,
      message: async (input) => {
        const messageID = "messageID" in input ? input.messageID : input.path.messageID
        return storedMessages.find((message) => message.info.id === messageID) ?? storedMessages[0]
      },
    },
    provider: {
      list: async () => ({ all: [] }),
    },
    auth: {
      set: async () => undefined,
    },
    app: {
      log: async () => undefined,
    },
  }
}

function countingClient(
  storedMessages: MessageWithPartsLike[],
  parentID: string | null = null,
  messageResult?: MessageWithPartsLike,
): { client: PluginClientLike; calls: { get: number; messages: number; message: number } } {
  const calls = { get: 0, messages: 0, message: 0 }
  const client: PluginClientLike = {
    session: {
      get: async () => {
        calls.get += 1
        return { id: "ses_1", parentID }
      },
      messages: async () => {
        calls.messages += 1
        return storedMessages
      },
      message: async (input) => {
        calls.message += 1
        const messageID = "messageID" in input ? input.messageID : input.path.messageID
        return messageResult ?? storedMessages.find((message) => message.info.id === messageID) ?? storedMessages[0]
      },
    },
    provider: {
      list: async () => ({ all: [] }),
    },
    auth: {
      set: async () => undefined,
    },
    app: {
      log: async () => undefined,
    },
  }
  return { client, calls }
}

describe("activation", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
  })

  test("keyword stripping preserves exact examples", () => {
    expect(stripTriggerKeyword("$en hello", "$en", 0)).toBe("hello")
    expect(stripTriggerKeyword("hello $en world", "$en", 6)).toBe("hello world")
    expect(stripTriggerKeyword("hello\n$en world", "$en", 6)).toBe("hello\nworld")
    expect(stripTriggerKeyword("hello $en\nworld", "$en", 6)).toBe("hello\nworld")
    expect(stripTriggerKeyword("literal $en and trigger $en", "$en", 8)).toBe("literal and trigger $en")
  })

  test("multiple keywords match as a disjunction", () => {
    const match = findTriggerMatch([textPart("p1", "hello $tr world")], ["$en", "$tr"])
    expect(match?.keyword).toBe("$tr")
  })

  test("metadata round-trips through banner and user-part fallback", () => {
    const state = makeState()
    const withBanner = extractStoredState([
      storedMessage([
        textPart("banner", "banner", {
          synthetic: true,
          ignored: true,
          metadata: {
            ...state,
            translate_role: "activation_banner",
          },
        }),
      ]),
    ])
    expect(withBanner).toEqual(state)

    const withFallback = extractStoredState([
      storedMessage([
        textPart("user", "안녕", {
          metadata: {
            ...state,
            translate_en: "hello",
            translate_source_hash: hashText("안녕"),
          },
        }),
      ]),
    ])
    expect(withFallback).toEqual(state)
  })

  test("first-message-only activation ignores later triggers", async () => {
    let calls = 0
    const hooks = createHooks(
      {
        client: fakeClient([storedMessage([textPart("old", "previous message")])]),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "hello $en world")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(0)
    expect(output.parts).toHaveLength(1)
    expect((output.parts[0] as TextPartLike).text).toBe("hello $en world")
  })

  test("child sessions are a no-op", async () => {
    let calls = 0
    const hooks = createHooks(
      {
        client: fakeClient([], "ses_parent"),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "$en 안녕")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(0)
    expect(output.parts).toHaveLength(1)
    expect((output.parts[0] as TextPartLike).text).toBe("$en 안녕")
  })

  test("forked translated session inherits translation mode without a new trigger", async () => {
    let calls = 0
    const state = makeState()
    const hooks = createHooks(
      {
        client: fakeClient([
          storedMessage([
            textPart("hist", "이전 메시지", {
              metadata: {
                ...state,
                translate_en: "previous message",
                translate_source_hash: hashText("이전 메시지"),
              },
            }),
          ]),
        ]),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "새 메시지")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(1)
    expect(output.parts).toHaveLength(2)
    expect((output.parts[0] as TextPartLike).text).toBe("새 메시지\n\n_→ EN: EN:새 메시지_")
    expect((output.parts[0] as TextPartLike).ignored).toBe(true)
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBe("EN:새 메시지")
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[1] as TextPartLike).synthetic).toBe(true)
    expect((output.parts[1] as TextPartLike).text).toBe("EN:새 메시지")
  })

  test("forked untranslated session remains inactive", async () => {
    let calls = 0
    const hooks = createHooks(
      {
        client: fakeClient([storedMessage([textPart("old", "previous")])]),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "새 메시지")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(0)
    expect(output.parts).toHaveLength(1)
  })

  test("empty root session lookup before first chat does not block later activation", async () => {
    const counted = countingClient([])
    const calls: string[] = []
    const hooks = createHooks(
      {
        client: counted.client,
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text, direction }) => {
            calls.push(direction)
            return `EN:${text}`
          },
        },
      },
    )

    await hooks["experimental.text.complete"]!({ sessionID: "ses_1", messageID: "msg_assistant" } as never, {
      text: "pre-activation text",
    })

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "$en 안녕")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(counted.calls).toEqual({ get: 2, messages: 2, message: 0 })
    expect(calls).toEqual(["inbound"])
    expect((output.parts[0] as TextPartLike).text).toBe("안녕\n\n_→ EN: EN:안녕_")
    expect((output.parts[0] as TextPartLike).ignored).toBe(true)
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBe("EN:안녕")
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[1] as TextPartLike).synthetic).toBe(true)
    expect((output.parts[1] as TextPartLike).text).toBe("EN:안녕")
    expect((output.parts[2] as TextPartLike).metadata?.translate_role).toBe("activation_banner")
  })

  test("inactive session cache skips later session lookups", async () => {
    let translatorCalls = 0
    const counted = countingClient([])
    const hooks = createHooks(
      {
        client: counted.client,
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            translatorCalls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const firstOutput = {
      message: { id: "msg_first" },
      parts: [textPart("p1", "no trigger")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, firstOutput as never)

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    expect(translatorCalls).toBe(0)
    expect((firstOutput.parts[0] as TextPartLike).text).toBe("no trigger")

    const laterOutput = {
      message: { id: "msg_later" },
      parts: [textPart("p2", "$en later trigger")],
    }
    const transformOutput = {
      messages: [storedMessage([textPart("hist", "previous")])],
    }
    const completeOutput = { text: "assistant text" }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, laterOutput as never)
    await hooks["experimental.chat.messages.transform"]!({} as never, transformOutput as never)
    await hooks["experimental.text.complete"]!(
      { sessionID: "ses_1", messageID: "msg_assistant" } as never,
      completeOutput,
    )

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    expect(translatorCalls).toBe(0)
    expect((laterOutput.parts[0] as TextPartLike).text).toBe("$en later trigger")
    expect(completeOutput.text).toBe("assistant text")
  })

  test("active session cache skips repeated state lookups across hooks", async () => {
    const assistantMessage = storedMessage([textPart("assistant", "hello")], "assistant")
    const counted = countingClient([], null, assistantMessage)
    const calls: string[] = []
    const hooks = createHooks(
      {
        client: counted.client,
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text, direction }) => {
            calls.push(direction)
            return direction === "inbound" ? `EN:${text}` : `KO:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "$en 안녕")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    expect(calls).toEqual(["inbound"])

    const transformOutput = {
      messages: [storedMessage([{ ...(output.parts[0] as TextPartLike) }])],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, transformOutput as never)

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    // transform no longer rewrites user parts. The source-language text
    // (now augmented with an inline `→ EN: ...` preview) stays as-is and
    // `ignored:true` keeps it out of the LLM serialization; the LLM-only
    // synthetic twin (created in chat.message) carries the English
    // prompt instead.
    expect((transformOutput.messages[0].parts[0] as TextPartLike).text).toBe("안녕\n\n_→ EN: EN:안녕_")
    expect((transformOutput.messages[0].parts[0] as TextPartLike).ignored).toBe(true)

    const completeOutput = { text: "hello" }
    await hooks["experimental.text.complete"]!(
      { sessionID: "ses_1", messageID: "msg_assistant" } as never,
      completeOutput,
    )

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 1 })
    expect(calls).toEqual(["inbound", "outbound"])
    expect(completeOutput.text).toContain("KO:hello")
  })

  test("multi-part ordering stays exact on activation turn", async () => {
    const hooks = createHooks(
      {
        client: fakeClient([]),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko", translatorModel: "anthropic/claude-haiku-4-5" },
      {
        translator: {
          translateText: async ({ text }) => `EN:${text}`,
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "$en 첫번째"), filePart(), textPart("p2", "두번째")],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    // Per user-authored text part we now emit two slots:
    //   - the original source-language text, augmented in place with the
    //     inline `→ EN: ...` preview and marked `ignored:true`
    //   - a synthetic LLM-only English twin
    // The file part stays in place, and the activation banner still
    // closes the message.
    expect(output.parts).toHaveLength(6)
    expect((output.parts[0] as TextPartLike).text).toBe("첫번째\n\n_→ EN: EN:첫번째_")
    expect((output.parts[0] as TextPartLike).ignored).toBe(true)
    expect((output.parts[1] as TextPartLike).text).toBe("EN:첫번째")
    expect((output.parts[1] as TextPartLike).synthetic).toBe(true)
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[2] as TextPartLike).type).toBe("file")
    expect((output.parts[3] as TextPartLike).text).toBe("두번째\n\n_→ EN: EN:두번째_")
    expect((output.parts[3] as TextPartLike).ignored).toBe(true)
    expect((output.parts[4] as TextPartLike).text).toBe("EN:두번째")
    expect((output.parts[4] as TextPartLike).synthetic).toBe(true)
    expect((output.parts[4] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[5] as TextPartLike).text).toContain("✓ Translation mode enabled")
    expect((output.parts[1] as TextPartLike).metadata?.translate_part_index).toBe(0)
    expect((output.parts[4] as TextPartLike).metadata?.translate_part_index).toBe(1)
    expect((output.parts[5] as TextPartLike).metadata?.translate_role).toBe("activation_banner")
  })

  test("OPENCODE_TRANSLATE_DISABLE=1 returns an empty hook map", () => {
    const previous = process.env.OPENCODE_TRANSLATE_DISABLE
    process.env.OPENCODE_TRANSLATE_DISABLE = "1"
    try {
      const hooks = createHooks(
        {
          client: fakeClient([]),
          directory: "/workspace",
        } as never,
        { sourceLanguage: "ko", displayLanguage: "ko" },
      )
      expect(hooks).toEqual({})
      expect(hooks["chat.message"]).toBeUndefined()
      expect(hooks["experimental.chat.messages.transform"]).toBeUndefined()
      expect(hooks["experimental.text.complete"]).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TRANSLATE_DISABLE
      else process.env.OPENCODE_TRANSLATE_DISABLE = previous
    }
  })
})
