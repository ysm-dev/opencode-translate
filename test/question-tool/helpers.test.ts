import { describe, expect, test } from "bun:test"
import {
  buildRestoredOutput,
  isQuestionArgs,
  restoreQuestionOutput,
  snapshotQuestions,
  translateQuestionArgs,
} from "../../src/question-tool"
import { cloneSampleArgs, sampleArgs } from "./helpers"

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
    const args = cloneSampleArgs()
    const seenBatches: string[][] = []
    await translateQuestionArgs(args, async (texts) => {
      seenBatches.push([...texts])
      return texts.map((text) => `[ko]${text}`)
    })

    expect(seenBatches).toEqual([
      ["Are you sure?", "Confirm", "Yes, delete", "This cannot be undone.", "No, cancel", "Keep the file."],
    ])
    expect(args.questions[0].question).toBe("[ko]Are you sure?")
    expect(args.questions[0].header).toBe("[ko]Confirm")
    expect(args.questions[0].options[0].label).toBe("[ko]Yes, delete")
    expect(args.questions[0].options[1].description).toBe("[ko]Keep the file.")
  })

  test("translateQuestionArgs leaves args unchanged when one translation fails", async () => {
    const args = cloneSampleArgs()
    let calls = 0

    await expect(
      translateQuestionArgs(args, async (texts) => {
        calls += 1
        expect(texts).toContain("Confirm")
        throw new Error("translator down")
      }),
    ).rejects.toThrow("translator down")

    expect(calls).toBe(1)
    expect(args).toEqual(cloneSampleArgs())
  })

  test("buildRestoredOutput reconstructs the English output from a Korean answer", async () => {
    const original = snapshotQuestions(sampleArgs)
    const translated = snapshotQuestions(sampleArgs)
    translated[0].question = "확실합니까?"
    translated[0].options[0].label = "예, 삭제"
    translated[0].options[1].label = "아니오, 취소"
    const translatedCustomAnswers: string[] = []

    const out = await buildRestoredOutput(original, translated, [["예, 삭제"]], {
      translateCustomAnswers: async (texts) => {
        translatedCustomAnswers.push(...texts)
        return texts.map((text) => `EN:${text}`)
      },
    })
    expect(out).toBe(
      'User has answered your questions: "Are you sure?"="Yes, delete". You can now continue with the user\'s answers in mind.',
    )
    expect(translatedCustomAnswers).toEqual([])
  })

  test("buildRestoredOutput handles custom and unanswered cases", async () => {
    const original = snapshotQuestions(sampleArgs)
    const translated = snapshotQuestions(sampleArgs)
    translated[0].question = "확실합니까?"
    translated[0].options[0].label = "예, 삭제"
    translated[0].options[1].label = "아니오, 취소"

    expect(await buildRestoredOutput(original, translated, [["직접 입력한 답변"]])).toContain(
      '"Are you sure?"="직접 입력한 답변"',
    )

    const seenBatches: string[][] = []
    const custom = await buildRestoredOutput(original, translated, [["직접 입력한 답변"]], {
      translateCustomAnswers: async (texts) => {
        seenBatches.push([...texts])
        return texts.map((text) => `<text>\nEN:${text}\n</text>`)
      },
    })
    expect(seenBatches).toEqual([["직접 입력한 답변"]])
    expect(custom).toContain('"Are you sure?"="EN:직접 입력한 답변"')

    let calls = 0
    const unanswered = await buildRestoredOutput(original, translated, [[]], {
      translateCustomAnswers: async (texts) => {
        calls += 1
        return texts.map((text) => `EN:${text}`)
      },
    })
    expect(unanswered).toContain('"Are you sure?"="Unanswered"')
    expect(calls).toBe(0)
  })

  test("restoreQuestionOutput no-ops when output.output is missing", async () => {
    const snapshot = {
      original: snapshotQuestions(sampleArgs),
      translated: snapshotQuestions(sampleArgs),
      userLanguage: "Korean",
    }
    const out: { title: string; metadata: { answers: string[][] } } = {
      title: "Asked 1 question",
      metadata: { answers: [["Yes, delete"]] },
    }
    await restoreQuestionOutput(out as never, snapshot)
    expect((out as unknown as { output?: string }).output).toBeUndefined()
  })

  test("restoreQuestionOutput rewrites metadata answers", async () => {
    const original = snapshotQuestions(sampleArgs)
    const translated = snapshotQuestions(sampleArgs)
    translated[0].question = "확실합니까?"
    translated[0].options[0].label = "예, 삭제"
    translated[0].options[1].label = "아니오, 취소"
    const out = {
      output: `User has answered your questions: "확실합니까?"="예, 삭제". You can now continue with the user's answers in mind.`,
      metadata: { answers: [["예, 삭제"]] },
    }

    await restoreQuestionOutput(out, { original, translated, userLanguage: "Korean" })

    expect(out.output).toContain('"Are you sure?"="Yes, delete"')
    expect(out.metadata.answers).toEqual([["Yes, delete"]])
  })
})
