import { expect, spyOn, test } from "bun:test"
import { setup } from "../src/activation"
import { host, requestContext } from "./helpers"
import { cloneSampleArgs } from "./question-tool/helpers"

test("before hook replaces frozen provider input and preserves the original question data", async () => {
  const h = host()
  h.values.set("sessions/ses_1", "Korean")
  h.generate(async (input) =>
    input
      .match(/<segment index="\d+">[\s\S]*?<\/segment>/g)!
      .map((text) => text.replace(/(<segment index="\d+">\n)([\s\S]*?)(\n<\/segment>)/, "$1translated:$2$3"))
      .join("\n"),
  )
  await setup(h.ctx)
  const original = cloneSampleArgs()
  for (const question of original.questions) {
    for (const option of question.options) Object.freeze(option)
    Object.freeze(question.options)
    Object.freeze(question)
  }
  Object.freeze(original.questions)
  Object.freeze(original)
  const event = { tool: "question", sessionID: "ses_1", id: "frozen_call", input: original }
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    await h.emit("tool.execute.before", event)
    expect(log).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
  expect(event.input).not.toBe(original)
  expect(event.input.questions[0].question).toBe("translated:Are you sure?")
  expect(event.input.questions[0].options[0].label).toBe("translated:Yes, delete")
  expect(original).toEqual(cloneSampleArgs())
  const after = {
    ...event,
    status: "completed",
    result: {
      content: "question result",
      output: { answers: [["translated:Yes, delete"]] },
      metadata: { answers: [["translated:Yes, delete"]] },
    },
  }
  await h.emit("tool.execute.after", after)
  expect(after.result.output.answers).toEqual([["Yes, delete"]])
  expect(after.result.content).toContain('"Are you sure?"="Yes, delete"')
})

test("v2 question forms translate, restore labels and custom answers, and update structured output", async () => {
  const h = host()
  h.values.set("sessions/ses_1", "Korean")
  h.generate(async (input) =>
    input
      .match(/<segment index="\d+">[\s\S]*?<\/segment>/g)!
      .map((text) => text.replace(/(<segment index="\d+">\n)([\s\S]*?)(\n<\/segment>)/, "$1translated:$2$3"))
      .join("\n"),
  )
  await setup(h.ctx)
  const event = { tool: "question", sessionID: "ses_1", id: "call_1", input: cloneSampleArgs() }
  await h.emit("tool.execute.before", event)
  expect(event.input.questions[0].question).toBe("translated:Are you sure?")
  const after = {
    ...event,
    status: "completed",
    result: {
      content: [{ type: "text", text: "native question result" }],
      output: { answers: [["translated:Yes, delete", "사용자 답변"]] },
      metadata: { answers: [["translated:Yes, delete", "사용자 답변"]], keep: true },
    },
  }
  await h.emit("tool.execute.after", after)
  expect(after.input.questions[0].question).toBe("translated:Are you sure?")
  const context = requestContext([
    { role: "assistant", content: [{ type: "tool-call", name: "question", id: "call_1", input: after.input }] },
  ])
  await h.emit("session.context", context)
  expect(context.messages).toMatchObject([{ content: [{ input: cloneSampleArgs() }] }])
  expect(after.result.content as unknown).toBe(
    'User has answered your questions: "Are you sure?"="Yes, delete, translated:사용자 답변". You can now continue with the user\'s answers in mind.',
  )
  expect(after.result.output.answers).toEqual([["Yes, delete", "translated:사용자 답변"]])
  expect(after.result.metadata.keep).toBe(true)
})
test("failed question calls release snapshots, with call IDs isolated by session", async () => {
  const h = host({ lang: "English" })
  h.values.set("sessions/ses_1", "English")
  await setup(h.ctx)
  const event = { tool: "question", sessionID: "ses_1", id: "call_1", input: cloneSampleArgs() }
  await h.emit("tool.execute.before", event)
  await h.emit("tool.execute.after", { ...event, status: "error", error: { message: "cancelled" } })
  const after = { ...event, status: "completed", result: { content: "untouched", metadata: { answers: [] } } }
  await h.emit("tool.execute.after", after)
  expect(after.result.content).toBe("untouched")
})
test("question translation errors preserve the form and custom answer errors preserve the answer", async () => {
  const h = host()
  h.values.set("sessions/ses_1", "Korean")
  h.generate(async () => {
    throw new Error("translator offline")
  })
  await setup(h.ctx)
  const event = { tool: "question", sessionID: "ses_1", id: "call_1", input: cloneSampleArgs() }
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    await h.emit("tool.execute.before", event)
    expect(event.input).toEqual(cloneSampleArgs())
    h.generate(async (input) => input.match(/<segment index="\d+">[\s\S]*?<\/segment>/g)!.join("\n"))
    await h.emit("tool.execute.before", event)
    h.generate(async () => {
      throw new Error("translator offline")
    })
    const after = {
      ...event,
      status: "completed",
      result: { content: "original", metadata: { answers: [["사용자 답변"]] } },
    }
    await h.emit("tool.execute.after", after)
    expect(after.result.content).toContain("사용자 답변")
    expect(log).toHaveBeenCalledTimes(2)
  } finally {
    log.mockRestore()
  }
})
