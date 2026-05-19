import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import type { TextPartLike } from "../../src/constants"
import { hashText } from "../../src/translator"
import { fakeClient, makeState, storedMessage, textPart } from "./helpers"

describe("activation chat.message", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
  })

  test("later root-session trigger activates from that message", async () => {
    let calls = 0
    const hooks = createHooks(
      { client: fakeClient([storedMessage([textPart("old", "previous message")])]), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "hello $en world")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(1)
    expect(output.parts).toHaveLength(3)
    expect((output.parts[0] as TextPartLike).text).toContain("hello world\n\n→ EN: EN:hello world")
    expect((output.parts[0] as TextPartLike).text).toContain("✓ Translation mode enabled")
    expect((output.parts[0] as TextPartLike).text).not.toContain("$en")
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBe("EN:hello world")
    expect((output.parts[1] as TextPartLike).text).toBe("EN:hello world")
    expect((output.parts[1] as TextPartLike).synthetic).toBe(true)
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[2] as TextPartLike).metadata?.translate_role).toBe("activation_banner")
  })

  test("child sessions are a no-op", async () => {
    let calls = 0
    const hooks = createHooks(
      { client: fakeClient([], "ses_parent"), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "$en 안녕")] }
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
              metadata: { ...state, translate_en: "previous message", translate_source_hash: hashText("이전 메시지") },
            }),
          ]),
        ]),
        directory: "/workspace",
      } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "새 메시지")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(1)
    expect(output.parts).toHaveLength(2)
    const forkVisibleParts = (output.parts as TextPartLike[]).filter(
      (part) => part.type === "text" && part.synthetic !== true && part.ignored !== true,
    )
    expect(forkVisibleParts.map((part) => part.id)).toEqual(["p1"])
    expect((output.parts[0] as TextPartLike).text).toBe("새 메시지\n\n→ EN: EN:새 메시지")
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBe("EN:새 메시지")
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
  })

  test("untranslated root session without trigger remains inactive", async () => {
    let calls = 0
    const hooks = createHooks(
      { client: fakeClient([storedMessage([textPart("old", "previous")])]), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "새 메시지")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(calls).toBe(0)
    expect(output.parts).toHaveLength(1)
  })
})
