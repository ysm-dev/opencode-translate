import { beforeEach, describe, expect, test } from "bun:test"
import {
  __resetActivationCacheForTest,
  createHooks,
  extractStoredState,
  findTriggerMatch,
  stripTriggerKeyword,
} from "../../src/activation"
import { hashText } from "../../src/translator"
import { fakeClient, makeState, storedMessage, textPart } from "./helpers"

describe("activation trigger and state", () => {
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
          metadata: { ...state, translate_role: "activation_banner" },
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

  test("OPENCODE_TRANSLATE_DISABLE=1 returns an empty hook map", () => {
    const previous = process.env.OPENCODE_TRANSLATE_DISABLE
    process.env.OPENCODE_TRANSLATE_DISABLE = "1"
    try {
      const hooks = createHooks({ client: fakeClient([]), directory: "/workspace" } as never, {
        model: "anthropic/claude-haiku-4-5",
        lang: "Korean",
      })
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
