import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import type { MessageWithPartsLike, PluginClientLike, TextPartLike, TranslateState } from "../../src/constants"
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
      { sourceLanguage: "ko", displayLanguage: "ko" },
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

    expect((chatOutput.parts[0] as TextPartLike).text).toContain("안녕\n\n_→ EN: EN:안녕_")
    expect((chatOutput.parts[1] as TextPartLike).text).toBe("EN:안녕")
    expect((chatOutput.parts[2] as TextPartLike).metadata?.translate_role).toBe("activation_banner")

    const state = (chatOutput.parts[2] as TextPartLike).metadata as unknown as TranslateState
    const transformOutput = {
      messages: [
        { info: { id: "msg_user", sessionID: "ses_1", role: "user" }, parts: chatOutput.parts },
        {
          info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant" },
          parts: [
            textPart(
              "a1",
              composeTranslatedAssistantText("English answer", "한국어 번역", "한국어 답변", state.translate_nonce),
            ),
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
      { sourceLanguage: "ko", displayLanguage: "ko" },
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

    expect(output.text).toBe(composeTranslationFailureText("English text", "0123456789abcdef0123456789abcdef"))
    expect(logs).toEqual(["outbound translator unavailable"])
  })
})
