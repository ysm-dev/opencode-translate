import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import type { TextPartLike } from "../../src/constants"
import { countingClient, storedMessage, textPart } from "./helpers"

describe("activation session cache", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
  })

  test("empty root session lookup before first chat does not block later activation", async () => {
    const counted = countingClient([])
    const calls: string[] = []
    const hooks = createHooks(
      { client: counted.client, directory: "/workspace" } as never,
      { lang: "Korean" },
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
    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "$en 안녕")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    expect(calls).toEqual(["inbound"])
    expect((output.parts[0] as TextPartLike).text).toContain("안녕\n\n_→ EN: EN:안녕_")
    expect((output.parts[0] as TextPartLike).text).toContain("✓ Translation mode enabled")
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[2] as TextPartLike).metadata?.translate_role).toBe("activation_banner")
  })

  test("inactive root cache still allows later activation", async () => {
    let translatorCalls = 0
    const counted = countingClient([])
    const hooks = createHooks(
      { client: counted.client, directory: "/workspace" } as never,
      { lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => {
            translatorCalls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const firstOutput = { message: { id: "msg_first" }, parts: [textPart("p1", "no trigger")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, firstOutput as never)
    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    expect(translatorCalls).toBe(0)

    await hooks["experimental.chat.messages.transform"]!(
      {} as never,
      { messages: [storedMessage([textPart("hist", "previous")])] } as never,
    )
    const completeOutput = { text: "assistant text" }
    await hooks["experimental.text.complete"]!(
      { sessionID: "ses_1", messageID: "msg_assistant" } as never,
      completeOutput,
    )
    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })
    expect(completeOutput.text).toBe("assistant text")

    const laterOutput = { message: { id: "msg_later" }, parts: [textPart("p2", "$en later trigger")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, laterOutput as never)
    expect(translatorCalls).toBe(1)
    expect((laterOutput.parts[0] as TextPartLike).text).toContain("later trigger\n\n_→ EN: EN:later trigger_")
    expect((laterOutput.parts[2] as TextPartLike).metadata?.translate_role).toBe("activation_banner")
  })

  test("active session cache skips repeated state lookups across hooks", async () => {
    const assistantMessage = storedMessage([textPart("assistant", "hello")], "assistant")
    const counted = countingClient([], null, assistantMessage)
    const calls: string[] = []
    const hooks = createHooks(
      { client: counted.client, directory: "/workspace" } as never,
      { lang: "Korean" },
      {
        translator: {
          translateText: async ({ text, direction }) => {
            calls.push(direction)
            return direction === "inbound" ? `EN:${text}` : `KO:${text}`
          },
        },
      },
    )

    const output = { message: { id: "msg_new" }, parts: [textPart("p1", "$en 안녕")] }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)
    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 0 })

    const transformOutput = { messages: [storedMessage((output.parts as TextPartLike[]).map((part) => ({ ...part })))] }
    await hooks["experimental.chat.messages.transform"]!({} as never, transformOutput as never)
    expect((transformOutput.messages[0].parts[0] as TextPartLike).ignored).toBe(true)
    expect((transformOutput.messages[0].parts[1] as TextPartLike).text).toBe("EN:안녕")

    const completeOutput = { text: "hello" }
    await hooks["experimental.text.complete"]!(
      { sessionID: "ses_1", messageID: "msg_assistant" } as never,
      completeOutput,
    )
    expect(counted.calls).toEqual({ get: 1, messages: 1, message: 1 })
    expect(calls).toEqual(["inbound", "outbound"])
    expect(completeOutput.text).toContain("KO:hello")
  })
})
