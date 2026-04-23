import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../src/activation"
import type { PluginClientLike } from "../src/constants"
import {
  buildRestoredOutput,
  isQuestionArgs,
  type QuestionArgs,
  restoreQuestionOutput,
  snapshotQuestions,
  translateQuestionArgs,
} from "../src/question-tool"

function fakeClient(): PluginClientLike {
  return {
    session: {
      get: async () => ({ data: { id: "ses_1", parentID: null } }),
      messages: async () => ({
        data: [
          {
            info: { id: "msg_banner", sessionID: "ses_1", role: "user" },
            parts: [
              {
                id: "banner",
                sessionID: "ses_1",
                messageID: "msg_banner",
                type: "text",
                text: "banner",
                synthetic: false,
                ignored: true,
                metadata: {
                  translate_enabled: true,
                  translate_source_lang: "ko",
                  translate_display_lang: "ko",
                  translate_llm_lang: "en",
                  translate_nonce: "a".repeat(32),
                  translate_role: "activation_banner",
                },
              },
            ],
          },
        ],
      }),
      message: async () => ({ data: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [] } }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    auth: { set: async () => ({ data: {} }) },
    app: {
      log: async () => ({ data: {} }),
    },
  } as unknown as PluginClientLike
}

const sampleArgs: QuestionArgs = {
  questions: [
    {
      question: "Are you sure?",
      header: "Confirm",
      options: [
        { label: "Yes, delete", description: "This cannot be undone." },
        { label: "No, cancel", description: "Keep the file." },
      ],
      multiple: false,
      custom: true,
    },
  ],
}

describe("question-tool helpers", () => {
  test("isQuestionArgs accepts the canonical shape and rejects bad input", () => {
    expect(isQuestionArgs(sampleArgs)).toBe(true)
    expect(isQuestionArgs({ questions: [{ question: "x", header: "h", options: [{ label: "l" }] }] })).toBe(false)
    expect(isQuestionArgs(null)).toBe(false)
    expect(isQuestionArgs({ questions: "nope" })).toBe(false)
  })

  test("snapshotQuestions deep-clones and preserves optional fields", () => {
    const snap = snapshotQuestions(sampleArgs)
    expect(snap).not.toBe(sampleArgs.questions)
    expect(snap[0]).not.toBe(sampleArgs.questions[0])
    expect(snap[0].options).not.toBe(sampleArgs.questions[0].options)
    expect(snap[0].multiple).toBe(false)
    expect(snap[0].custom).toBe(true)
  })

  test("translateQuestionArgs translates every display-facing field", async () => {
    const args: QuestionArgs = JSON.parse(JSON.stringify(sampleArgs))
    const seen: string[] = []
    await translateQuestionArgs(args, async (text) => {
      seen.push(text)
      return `[ko]${text}`
    })

    expect(new Set(seen)).toEqual(
      new Set(["Are you sure?", "Confirm", "Yes, delete", "This cannot be undone.", "No, cancel", "Keep the file."]),
    )
    expect(args.questions[0].question).toBe("[ko]Are you sure?")
    expect(args.questions[0].header).toBe("[ko]Confirm")
    expect(args.questions[0].options[0].label).toBe("[ko]Yes, delete")
    expect(args.questions[0].options[1].description).toBe("[ko]Keep the file.")
  })

  test("buildRestoredOutput reconstructs the English output from a Korean answer", () => {
    const original = snapshotQuestions(sampleArgs)
    const translated = snapshotQuestions(sampleArgs)
    translated[0].question = "확실합니까?"
    translated[0].options[0].label = "예, 삭제"
    translated[0].options[1].label = "아니오, 취소"

    const out = buildRestoredOutput(original, translated, [["예, 삭제"]])
    expect(out).toBe(
      'User has answered your questions: "Are you sure?"="Yes, delete". You can now continue with the user\'s answers in mind.',
    )
  })

  test("buildRestoredOutput preserves free-text custom answers verbatim", () => {
    const original = snapshotQuestions(sampleArgs)
    const translated = snapshotQuestions(sampleArgs)
    translated[0].question = "확실합니까?"
    translated[0].options[0].label = "예, 삭제"
    translated[0].options[1].label = "아니오, 취소"

    // User typed something that isn't one of the translated option labels.
    const out = buildRestoredOutput(original, translated, [["직접 입력한 답변"]])
    expect(out).toContain('"Are you sure?"="직접 입력한 답변"')
  })

  test("buildRestoredOutput renders Unanswered for an empty answer array", () => {
    const original = snapshotQuestions(sampleArgs)
    const translated = snapshotQuestions(sampleArgs)
    translated[0].question = "확실합니까?"

    const out = buildRestoredOutput(original, translated, [[]])
    expect(out).toContain('"Are you sure?"="Unanswered"')
  })

  test("restoreQuestionOutput no-ops when output.output is missing", () => {
    const snapshot = { original: snapshotQuestions(sampleArgs), translated: snapshotQuestions(sampleArgs) }
    const out: { title: string; metadata: { answers: string[][] } } = {
      title: "Asked 1 question",
      metadata: { answers: [["Yes, delete"]] },
    }
    restoreQuestionOutput(out as never, snapshot)
    expect((out as unknown as { output?: string }).output).toBeUndefined()
  })
})

describe("tool.execute hooks", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
  })

  test("tool.execute.before translates question args when state is active", async () => {
    const hooks = createHooks(
      { client: fakeClient(), directory: "/workspace" } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => `[ko]${text}`,
        },
      },
    )

    const args: QuestionArgs = JSON.parse(JSON.stringify(sampleArgs))
    await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_1" }, { args } as never)

    expect(args.questions[0].question).toBe("[ko]Are you sure?")
    expect(args.questions[0].options[0].label).toBe("[ko]Yes, delete")
  })

  test("tool.execute.before is a no-op for non-question tools", async () => {
    const hooks = createHooks(
      { client: fakeClient(), directory: "/workspace" } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async () => {
            throw new Error("should not be called")
          },
        },
      },
    )

    const args = { command: "ls -la" }
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "call_2" }, { args } as never)

    expect(args).toEqual({ command: "ls -la" })
  })

  test("tool.execute.before is a no-op when displayLanguage equals English", async () => {
    const hooks = createHooks(
      { client: fakeClient(), directory: "/workspace" } as never,
      { sourceLanguage: "ko", displayLanguage: "en" },
      {
        translator: {
          translateText: async () => {
            throw new Error("should not be called")
          },
        },
      },
    )

    const args: QuestionArgs = JSON.parse(JSON.stringify(sampleArgs))
    await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_3" }, { args } as never)

    expect(args.questions[0].question).toBe("Are you sure?")
  })

  test("tool.execute.after restores the English output string", async () => {
    const hooks = createHooks(
      { client: fakeClient(), directory: "/workspace" } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => `[ko]${text}`,
        },
      },
    )

    const args: QuestionArgs = JSON.parse(JSON.stringify(sampleArgs))
    await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_4" }, { args } as never)

    const afterOutput = {
      title: "Asked 1 question",
      output: `User has answered your questions: "[ko]Are you sure?"="[ko]Yes, delete". You can now continue with the user's answers in mind.`,
      metadata: { answers: [["[ko]Yes, delete"]] },
    }

    await hooks["tool.execute.after"]!(
      { tool: "question", sessionID: "ses_1", callID: "call_4", args },
      afterOutput as never,
    )

    expect(afterOutput.output).toBe(
      'User has answered your questions: "Are you sure?"="Yes, delete". You can now continue with the user\'s answers in mind.',
    )
  })

  test("tool.execute.after swallows translator errors from the before hook and leaves args English", async () => {
    const hooks = createHooks(
      { client: fakeClient(), directory: "/workspace" } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async () => {
            throw new Error("translator down")
          },
        },
      },
    )

    const args: QuestionArgs = JSON.parse(JSON.stringify(sampleArgs))
    // Must not throw even though translation fails
    await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_5" }, { args } as never)

    // Args stay in English so the UI at least renders the original
    expect(args.questions[0].question).toBe("Are you sure?")
    expect(args.questions[0].options[0].label).toBe("Yes, delete")

    // After hook is a no-op because no snapshot was stored
    const afterOutput = { title: "x", output: "unchanged", metadata: { answers: [] } }
    await hooks["tool.execute.after"]!(
      { tool: "question", sessionID: "ses_1", callID: "call_5", args },
      afterOutput as never,
    )
    expect(afterOutput.output).toBe("unchanged")
  })
})
