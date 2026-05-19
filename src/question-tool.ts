// Translation layer for OpenCode's built-in `question` tool.
//
// Flow:
//   1. Agent (main LLM, English-only) invokes the `question` tool with an
//      `args.questions[]` payload in English.
//   2. `tool.execute.before` hook translates each question's text, header,
//      and every option's label + description into the configured `lang` so the
//      question prompt renders in the user's language.
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
}

export interface QuestionToolOutput {
  title?: string
  output?: string
  metadata?: { answers?: readonly (readonly string[])[] } | Record<string, unknown>
}

export interface RestoreQuestionOutputOptions {
  translateCustomAnswer?: (text: string) => Promise<string>
  onTranslationError?: (error: unknown) => Promise<void> | void
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

async function assignTranslation(
  container: Record<string, string>,
  key: string,
  translate: (text: string) => Promise<string>,
): Promise<void> {
  const original = container[key]
  if (!original || original.length === 0) return
  const translated = await translate(original)
  container[key] = unwrapEchoedTextEnvelope(translated)
}

// Translate every display-facing string in `args` in parallel. The caller can
// snapshot the translated form afterward with `snapshotQuestions`.
export async function translateQuestionArgs(
  args: QuestionArgs,
  translate: (text: string) => Promise<string>,
): Promise<void> {
  const jobs: Promise<void>[] = []

  for (const q of args.questions) {
    jobs.push(assignTranslation(q as unknown as Record<string, string>, "question", translate))
    jobs.push(assignTranslation(q as unknown as Record<string, string>, "header", translate))
    for (const option of q.options) {
      jobs.push(assignTranslation(option as unknown as Record<string, string>, "label", translate))
      jobs.push(assignTranslation(option as unknown as Record<string, string>, "description", translate))
    }
  }

  await Promise.all(jobs)
}

// Given a user-selected label, find the matching translated option and return
// its original English label. If no match exists, OpenCode only gives us the
// raw answer string, so treat non-empty text as a custom answer and translate
// it through the same source-language -> English path as normal user messages.
async function restoreLabel(
  selectedLabel: string,
  translatedOptions: readonly OptionRecord[],
  originalOptions: readonly OptionRecord[],
  options: RestoreQuestionOutputOptions,
): Promise<string> {
  const idx = translatedOptions.findIndex((option) => option.label === selectedLabel)
  if (idx >= 0) return originalOptions[idx]?.label ?? selectedLabel
  if (!options.translateCustomAnswer || selectedLabel.trim().length === 0) return selectedLabel

  try {
    const translated = await options.translateCustomAnswer(selectedLabel)
    return unwrapEchoedTextEnvelope(translated)
  } catch (error) {
    await options.onTranslationError?.(error)
    return selectedLabel
  }
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
  const formattedParts = await Promise.all(
    original.map(async (q, i) => {
      const selected = answers[i] ?? []
      const translatedOptions = translated[i]?.options ?? []
      const originalOptions = q.options
      const restored = await Promise.all(
        selected.map((label) => restoreLabel(label, translatedOptions, originalOptions, options)),
      )
      const rendered = restored.length > 0 ? restored.join(", ") : "Unanswered"
      return `"${q.question}"="${rendered}"`
    }),
  )
  const formatted = formattedParts.join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export async function restoreQuestionOutput(
  output: QuestionToolOutput,
  snapshot: QuestionSnapshot,
  options: RestoreQuestionOutputOptions = {},
): Promise<void> {
  if (typeof output.output !== "string") return
  const answersRaw = (output.metadata as { answers?: readonly (readonly string[])[] } | undefined)?.answers
  const answers = Array.isArray(answersRaw) ? answersRaw : []
  output.output = await buildRestoredOutput(snapshot.original, snapshot.translated, answers, options)
}
