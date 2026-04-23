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
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("translation_preview")
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

    expect(output.parts).toHaveLength(6)
    expect((output.parts[0] as TextPartLike).text).toBe("첫번째")
    expect((output.parts[1] as TextPartLike).text).toBe("→ EN: EN:첫번째")
    expect((output.parts[2] as TextPartLike).type).toBe("file")
    expect((output.parts[3] as TextPartLike).text).toBe("두번째")
    expect((output.parts[4] as TextPartLike).text).toBe("→ EN: EN:두번째")
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
