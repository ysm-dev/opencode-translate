import { beforeEach, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import { cloneSampleArgs, fakeClient } from "./helpers"

beforeEach(() => {
  __resetActivationCacheForTest()
})

test("tool.execute.before translates question args when state is active", async () => {
  const batches: string[][] = []
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async ({ text }) => `[ko]${text}`,
        translateTexts: async ({ texts }) => {
          batches.push([...texts])
          return texts.map((text) => `[ko]${text}`)
        },
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_1" }, { args } as never)
  expect(args.questions[0].question).toBe("[ko]Are you sure?")
  expect(args.questions[0].options[0].label).toBe("[ko]Yes, delete")
  expect(batches).toEqual([
    ["Are you sure?", "Confirm", "Yes, delete", "This cannot be undone.", "No, cancel", "Keep the file."],
  ])
})

test("tool.execute.before removes echoed text envelope from translated question args", async () => {
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async ({ text }) => `<text>\n[ko]${text}\n</text>`,
        translateTexts: async ({ texts }) => texts.map((text) => `<text>\n[ko]${text}\n</text>`),
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_wrapped" }, {
    args,
  } as never)
  expect(args.questions[0].question).toBe("[ko]Are you sure?")
  expect(args.questions[0].options[0].label).toBe("[ko]Yes, delete")
  expect(args.questions[0].question).not.toContain("<text>")
})

test("tool.execute.before no-ops for non-question tools and English language", async () => {
  const nonQuestionHooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async () => {
          throw new Error("should not be called")
        },
      },
    },
  )
  const nonQuestionArgs = { command: "ls -la" }
  await nonQuestionHooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "call_2" }, {
    args: nonQuestionArgs,
  } as never)
  expect(nonQuestionArgs).toEqual({ command: "ls -la" })

  const englishHooks = createHooks(
    { client: fakeClient({ translate_user_lang: "English" }), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "English" },
    {
      translator: {
        translateText: async () => {
          throw new Error("should not be called")
        },
      },
    },
  )
  const englishArgs = cloneSampleArgs()
  await englishHooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_3" }, {
    args: englishArgs,
  } as never)
  expect(englishArgs.questions[0].question).toBe("Are you sure?")
})

test("tool.execute.after restores the English output string", async () => {
  const calls: string[] = []
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async ({ text, direction }) => {
          calls.push(`${direction}:${text}`)
          return `[ko]${text}`
        },
        translateTexts: async ({ texts, direction }) => {
          calls.push(`${direction}:${texts.join("|")}`)
          return texts.map((text) => `[ko]${text}`)
        },
      },
    },
  )

  const args = cloneSampleArgs()
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
  expect(afterOutput.metadata.answers).toEqual([["Yes, delete"]])
  expect(args.questions[0].question).toBe("Are you sure?")
  expect(args.questions[0].options[0].label).toBe("Yes, delete")
  expect(calls).toEqual(["outbound:Are you sure?|Confirm|Yes, delete|This cannot be undone.|No, cancel|Keep the file."])
  expect(calls).not.toContain("inbound:[ko]Yes, delete")
})

test("tool.execute.after translates free-text custom answers", async () => {
  const calls: string[] = []
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async ({ text, direction }) => {
          calls.push(`${direction}:${text}`)
          return direction === "outbound" ? `[ko]${text}` : `EN:${text}`
        },
        translateTexts: async ({ texts, direction }) => {
          calls.push(`${direction}:${texts.join("|")}`)
          return texts.map((text) => (direction === "outbound" ? `[ko]${text}` : `EN:${text}`))
        },
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_custom" }, {
    args,
  } as never)
  const afterOutput = {
    title: "Asked 1 question",
    output: `User has answered your questions: "[ko]Are you sure?"="직접 입력한 답변". You can now continue with the user's answers in mind.`,
    metadata: { answers: [["직접 입력한 답변"]] },
  }

  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_custom", args },
    afterOutput as never,
  )
  expect(afterOutput.output).toContain('"Are you sure?"="EN:직접 입력한 답변"')
  expect(afterOutput.metadata.answers).toEqual([["EN:직접 입력한 답변"]])
  expect(args.questions[0].question).toBe("Are you sure?")
  expect(calls).toContain("inbound:직접 입력한 답변")
})

test("tool.execute.after falls back to translateText for custom answers", async () => {
  const calls: string[] = []
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async ({ text, direction }) => {
          calls.push(`${direction}:${text}`)
          return direction === "outbound" ? `[ko]${text}` : `EN:${text}`
        },
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_custom_fallback" }, {
    args,
  } as never)
  const afterOutput = {
    title: "Asked 1 question",
    output: `User has answered your questions: "[ko]Are you sure?"="직접 입력한 답변". You can now continue with the user's answers in mind.`,
    metadata: { answers: [["직접 입력한 답변"]] },
  }

  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_custom_fallback", args },
    afterOutput as never,
  )

  expect(afterOutput.output).toContain('"Are you sure?"="EN:직접 입력한 답변"')
  expect(afterOutput.metadata.answers).toEqual([["EN:직접 입력한 답변"]])
  expect(calls).toContain("inbound:직접 입력한 답변")
})

test("tool.execute.after does not translate custom answers when language is English", async () => {
  const calls: string[] = []
  const hooks = createHooks(
    { client: fakeClient({ translate_user_lang: "English" }), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "English" },
    {
      translator: {
        translateText: async ({ text, direction }) => {
          calls.push(`${direction}:${text}`)
          return `translated:${text}`
        },
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_display_en" }, {
    args,
  } as never)
  const afterOutput = {
    title: "Asked 1 question",
    output: `User has answered your questions: "Are you sure?"="custom answer". You can now continue with the user's answers in mind.`,
    metadata: { answers: [["custom answer"]] },
  }

  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_display_en", args },
    afterOutput as never,
  )
  expect(afterOutput.output).toContain('"Are you sure?"="custom answer"')
  expect(afterOutput.metadata.answers).toEqual([["custom answer"]])
  expect(args.questions[0].question).toBe("Are you sure?")
  expect(calls).toEqual([])
})

test("tool.execute.after swallows before-hook translation errors and leaves args English", async () => {
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async () => {
          throw new Error("translator down")
        },
        translateTexts: async () => {
          throw new Error("translator down")
        },
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_5" }, { args } as never)
  expect(args.questions[0].question).toBe("Are you sure?")
  expect(args.questions[0].options[0].label).toBe("Yes, delete")

  const afterOutput = { title: "x", output: "unchanged", metadata: { answers: [] } }
  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_5", args },
    afterOutput as never,
  )
  expect(afterOutput.output).toBe("unchanged")
})

test("tool.execute.before logs state lookup failures without throwing", async () => {
  const logs: string[] = []
  const client = {
    ...fakeClient(),
    session: {
      get: async () => {
        throw new Error("state unavailable")
      },
      messages: async () => ({ data: [] }),
      message: async () => ({ data: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [] } }),
    },
    app: {
      log: async (input: { body: { message: string } }) => {
        logs.push(input.body.message)
        return { data: {} }
      },
    },
  }
  const hooks = createHooks(
    { client, directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    { translator: { translateText: async ({ text }) => `[ko]${text}` } },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_lookup_fail" }, {
    args,
  } as never)

  expect(args.questions[0].question).toBe("Are you sure?")
  expect(logs).toEqual(["state unavailable"])
})

test("tool.execute.after logs custom answer translation failures with source-language context", async () => {
  const logs: string[] = []
  const hooks = createHooks(
    {
      client: {
        ...fakeClient(),
        app: {
          log: async (input: { body: { message: string } }) => {
            logs.push(input.body.message)
            return { data: {} }
          },
        },
      },
      directory: "/workspace",
    } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    {
      translator: {
        translateText: async ({ text, direction }) => {
          if (direction === "outbound") return `[ko]${text}`
          throw new Error("custom answer translator down")
        },
        translateTexts: async ({ texts, direction }) => {
          if (direction === "outbound") return texts.map((text) => `[ko]${text}`)
          throw new Error("custom answer translator down")
        },
      },
    },
  )

  const args = cloneSampleArgs()
  await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: "call_custom_fail" }, {
    args,
  } as never)
  const afterOutput = {
    title: "Asked 1 question",
    output: `User has answered your questions: "[ko]Are you sure?"="직접 입력". You can now continue with the user's answers in mind.`,
    metadata: { answers: [["직접 입력"]] },
  }

  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_custom_fail", args },
    afterOutput as never,
  )

  expect(afterOutput.output).toContain('"Are you sure?"="직접 입력"')
  expect(logs.at(-1)).toContain(
    "Failed to translate user message from Korean to English: custom answer translator down",
  )
})

test("question snapshots are capped to avoid unbounded retention", async () => {
  const hooks = createHooks(
    { client: fakeClient(), directory: "/workspace" } as never,
    { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
    { translator: { translateText: async ({ text }) => `[ko]${text}` } },
  )

  for (let index = 0; index < 1001; index += 1) {
    await hooks["tool.execute.before"]!({ tool: "question", sessionID: "ses_1", callID: `call_${index}` }, {
      args: cloneSampleArgs(),
    } as never)
  }

  const prunedOutput = {
    output: "unchanged",
    metadata: { answers: [["[ko]Yes, delete"]] },
  }
  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_0", args: cloneSampleArgs() } as never,
    prunedOutput as never,
  )
  expect(prunedOutput.output).toBe("unchanged")

  const retainedOutput = {
    output: "translated",
    metadata: { answers: [["[ko]Yes, delete"]] },
  }
  await hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "ses_1", callID: "call_1000", args: cloneSampleArgs() } as never,
    retainedOutput as never,
  )
  expect(retainedOutput.output).toContain('"Are you sure?"="Yes, delete"')
})
