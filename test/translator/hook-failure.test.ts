import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import { __resetAuthCachesForTest } from "../../src/auth"
import type { TextPartLike } from "../../src/constants"
import { __resetTranslatorCachesForTest } from "../../src/translator"
import { activeStateMetadata, fakeClient, textPart } from "./helpers"

describe("translator hook failures", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
    __resetAuthCachesForTest()
    __resetTranslatorCachesForTest()
  })

  test("final failure in chat.message does not throw and falls back to the untranslated text", async () => {
    const hooks = createHooks(
      { client: fakeClient([]), directory: "/workspace" } as never,
      { lang: "Korean" },
      {
        translator: {
          translateText: async () => {
            throw new Error("translator unavailable")
          },
        },
      },
    )

    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "$en 안녕")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect((output.parts[0] as TextPartLike).text).toContain("안녕")
    expect((output.parts[0] as TextPartLike).text).toContain("Translation failed")
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBeUndefined()
  })

  test("transform leaves user parts untouched on the LLM-only twin architecture", async () => {
    let calls = 0
    const messages = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [textPart("hist", "안녕", { metadata: activeStateMetadata("안녕") })],
      },
    ]
    const hooks = createHooks(
      { client: fakeClient(messages), directory: "/workspace" } as never,
      { lang: "Korean" },
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
      messages: [
        {
          info: { id: "msg_user", sessionID: "ses_1", role: "user" },
          parts: [textPart("hist", "안녕", { metadata: activeStateMetadata("안녕") })],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, output as never)

    expect(calls).toBe(0)
    expect((output.messages[0].parts[0] as TextPartLike).text).toBe("안녕")
  })

  test("hash mismatch in transform does not throw and does not call the translator", async () => {
    let calls = 0
    const history = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [textPart("hist", "원본", { metadata: activeStateMetadata("원본") })],
      },
    ]
    const hooks = createHooks(
      { client: fakeClient(history), directory: "/workspace" } as never,
      { lang: "Korean" },
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
      messages: [
        {
          info: { id: "msg_user", sessionID: "ses_1", role: "user" },
          parts: [textPart("hist", "편집됨", { metadata: activeStateMetadata("원본") })],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as never, output as never)

    expect(calls).toBe(0)
    expect((output.messages[0].parts[0] as TextPartLike).text).toBe("편집됨")
  })
})
