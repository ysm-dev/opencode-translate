// Translation layer for OpenCode's built-in `question` tool.
//
// Flow:
//   1. Agent (main LLM, English-only) invokes the `question` tool with an
//      `args.questions[]` payload in English.
//   2. `tool.execute.before` hook translates all question text, headers, and
//      option labels + descriptions into the configured `lang` so the question
//      prompt renders in the user's language.
//   3. OpenCode publishes `question.asked`; the TUI shows the translated
//      dialog and the user picks an option (or types a custom answer).
//   4. `tool.execute.after` hook reverses the substitution using the
//      snapshot we captured in step 2. Selected options are restored by
//      label mapping; non-empty custom answers are translated like normal
//      user messages, so the output delivered back to the LLM stays in
//      English.
//
// A per-callID snapshot is kept so mapping a user-selected translated label
// back to its original English label is deterministic.

import { unwrapEchoedTextEnvelope } from "./prompts"

type TextRecord = { question: string; header: string; options: OptionRecord[]; multiple?: boolean; custom?: boolean }
type OptionRecord = { label: string; description: string }

export interface QuestionArgs {
  questions: TextRecord[]
}

export interface QuestionSnapshot {
  original: TextRecord[]
  translated: TextRecord[]
  userLanguage: string
}

export interface QuestionToolOutput {
  title?: string
  output?: string
  metadata?: { answers?: readonly (readonly string[])[] } | Record<string, unknown>
}

export interface RestoreQuestionOutputOptions {
  translateCustomAnswers?: (texts: readonly string[]) => Promise<readonly string[]>
  onTranslationError?: (error: unknown) => Promise<void> | void
}

interface TranslatableField {
  text: string
  set(value: string): void
}

interface CustomAnswerSlot {
  questionIndex: number
  answerIndex: number
  text: string
}

function cloneQuestion(q: TextRecord): TextRecord {
  return {
    question: q.question,
    header: q.header,
    options: q.options.map((option) => ({ label: option.label, description: option.description })),
    ...(q.multiple !== undefined ? { multiple: q.multiple } : {}),
    ...(q.custom !== undefined ? { custom: q.custom } : {}),
  }
}

export function snapshotQuestions(args: QuestionArgs): TextRecord[] {
  return args.questions.map(cloneQuestion)
}

export function restoreQuestionArgs(args: QuestionArgs, original: readonly TextRecord[]): void {
  args.questions.splice(0, args.questions.length, ...original.map(cloneQuestion))
}

export function isQuestionArgs(value: unknown): value is QuestionArgs {
  if (!value || typeof value !== "object") return false
  const questions = (value as Record<string, unknown>).questions
  if (!Array.isArray(questions)) return false
  for (const q of questions) {
    if (!q || typeof q !== "object") return false
    const record = q as Record<string, unknown>
    if (typeof record.question !== "string") return false
    if (typeof record.header !== "string") return false
    if (!Array.isArray(record.options)) return false
    for (const opt of record.options) {
      if (!opt || typeof opt !== "object") return false
      const optRecord = opt as Record<string, unknown>
      if (typeof optRecord.label !== "string") return false
      if (typeof optRecord.description !== "string") return false
    }
  }
  return true
}

// Translate every display-facing string in one batch, then commit the
// translated clone only after the batch succeeds.
export async function translateQuestionArgs(
  args: QuestionArgs,
  translate: (texts: readonly string[]) => Promise<readonly string[]>,
): Promise<void> {
  const translatedQuestions = snapshotQuestions(args)
  const fields: TranslatableField[] = []

  function addField(text: string, set: (value: string) => void) {
    if (text.length === 0) return
    fields.push({ text, set })
  }

  for (const q of translatedQuestions) {
    addField(q.question, (value) => {
      q.question = value
    })
    addField(q.header, (value) => {
      q.header = value
    })
    for (const option of q.options) {
      addField(option.label, (value) => {
        option.label = value
      })
      addField(option.description, (value) => {
        option.description = value
      })
    }
  }

  if (fields.length === 0) return

  const translated = await translate(fields.map((field) => field.text))
  if (translated.length !== fields.length) {
    throw new Error(`Question translator returned ${translated.length} translations for ${fields.length} fields`)
  }
  for (const [index, field] of fields.entries()) {
    field.set(unwrapEchoedTextEnvelope(translated[index]))
  }
  args.questions.splice(0, args.questions.length, ...translatedQuestions)
}

function restoreOptionLabel(
  selectedLabel: string,
  translatedOptions: readonly OptionRecord[],
  originalOptions: readonly OptionRecord[],
): string | undefined {
  const idx = translatedOptions.findIndex((option) => option.label === selectedLabel)
  if (idx < 0) return undefined
  return originalOptions[idx]?.label ?? selectedLabel
}

async function restoreQuestionAnswers(
  original: readonly TextRecord[],
  translated: readonly TextRecord[],
  answers: readonly (readonly string[])[],
  options: RestoreQuestionOutputOptions = {},
): Promise<string[][]> {
  const translateCustomAnswers = options.translateCustomAnswers
  const customSlots: CustomAnswerSlot[] = []
  const restored = original.map((q, questionIndex) => {
    const selected = answers[questionIndex] ?? []
    const translatedOptions = translated[questionIndex]?.options ?? []
    const originalOptions = q.options

    return selected.map((label, answerIndex) => {
      const restoredLabel = restoreOptionLabel(label, translatedOptions, originalOptions)
      if (restoredLabel !== undefined) return restoredLabel
      if (!translateCustomAnswers || label.trim().length === 0) return label

      customSlots.push({ questionIndex, answerIndex, text: label })
      return label
    })
  })

  if (!translateCustomAnswers || customSlots.length === 0) return restored

  try {
    const translatedCustomAnswers = await translateCustomAnswers(customSlots.map((slot) => slot.text))
    if (translatedCustomAnswers.length !== customSlots.length) {
      throw new Error(
        `Question custom-answer translator returned ${translatedCustomAnswers.length} translations for ${customSlots.length} answers`,
      )
    }
    for (const [index, slot] of customSlots.entries()) {
      restored[slot.questionIndex][slot.answerIndex] = unwrapEchoedTextEnvelope(translatedCustomAnswers[index])
    }
  } catch (error) {
    await options.onTranslationError?.(error)
  }

  return restored
}

function formatRestoredOutput(original: readonly TextRecord[], answers: readonly (readonly string[])[]): string {
  const formattedParts = original.map((q, i) => {
    const restored = answers[i] ?? []
    const rendered = restored.length > 0 ? restored.join(", ") : "Unanswered"
    return `"${q.question}"="${rendered}"`
  })
  const formatted = formattedParts.join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

// Reconstruct the exact output string the question tool would have produced
// if it had been called with the original English args. Mirrors the format
// in `packages/opencode/src/tool/question.ts` (as of opencode 1.14.x).
export async function buildRestoredOutput(
  original: readonly TextRecord[],
  translated: readonly TextRecord[],
  answers: readonly (readonly string[])[],
  options: RestoreQuestionOutputOptions = {},
): Promise<string> {
  const restoredAnswers = await restoreQuestionAnswers(original, translated, answers, options)
  return formatRestoredOutput(original, restoredAnswers)
}

function mutableMetadata(output: QuestionToolOutput): Record<string, unknown> {
  if (output.metadata && typeof output.metadata === "object" && !Array.isArray(output.metadata)) {
    return output.metadata as Record<string, unknown>
  }

  const metadata: Record<string, unknown> = {}
  output.metadata = metadata
  return metadata
}

export async function restoreQuestionOutput(
  output: QuestionToolOutput,
  snapshot: QuestionSnapshot,
  options: RestoreQuestionOutputOptions = {},
): Promise<void> {
  if (typeof output.output !== "string") return
  const answersRaw = (output.metadata as { answers?: readonly (readonly string[])[] } | undefined)?.answers
  const answers = Array.isArray(answersRaw) ? answersRaw : []
  const restoredAnswers = await restoreQuestionAnswers(snapshot.original, snapshot.translated, answers, options)
  output.output = formatRestoredOutput(snapshot.original, restoredAnswers)
  mutableMetadata(output).answers = restoredAnswers
}
