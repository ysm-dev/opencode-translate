// Translation layer for OpenCode's built-in `question` tool.
//
// Flow:
//   1. Agent (main LLM, English-only) invokes the `question` tool with an
//      `args.questions[]` payload in English.
//   2. `tool.execute.before` hook translates each question's text, header,
//      and every option's label + description into `displayLanguage` so the
//      question prompt renders in the user's language.
//   3. OpenCode publishes `question.asked`; the TUI shows the translated
//      dialog and the user picks an option (or types a custom answer).
//   4. `tool.execute.after` hook reverses the substitution using the
//      snapshot we captured in step 2, so the tool output string delivered
//      back to the LLM stays in English.
//
// A per-callID snapshot is kept so mapping a user-selected translated label
// back to its original English label is deterministic.

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
  container[key] = translated
}

// Translate every display-facing string in `args` in parallel. Returns the
// snapshot of the translated form so the caller can pair it with the
// pre-translation snapshot taken with `snapshotQuestions`.
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

// Given the user-selected labels (`answers`), find the matching translated
// option and return its original English label. If no match (e.g. a custom
// free-text answer), return the label verbatim so the LLM still sees what
// the user actually typed.
function restoreLabel(
  selectedLabel: string,
  translatedOptions: readonly OptionRecord[],
  originalOptions: readonly OptionRecord[],
): string {
  const idx = translatedOptions.findIndex((option) => option.label === selectedLabel)
  if (idx < 0) return selectedLabel
  return originalOptions[idx]?.label ?? selectedLabel
}

// Reconstruct the exact output string the question tool would have produced
// if it had been called with the original English args. Mirrors the format
// in `packages/opencode/src/tool/question.ts` (as of opencode 1.14.x).
export function buildRestoredOutput(
  original: readonly TextRecord[],
  translated: readonly TextRecord[],
  answers: readonly (readonly string[])[],
): string {
  const formatted = original
    .map((q, i) => {
      const selected = answers[i] ?? []
      const translatedOptions = translated[i]?.options ?? []
      const originalOptions = q.options
      const restored = selected.map((label) => restoreLabel(label, translatedOptions, originalOptions))
      const rendered = restored.length > 0 ? restored.join(", ") : "Unanswered"
      return `"${q.question}"="${rendered}"`
    })
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export function restoreQuestionOutput(output: QuestionToolOutput, snapshot: QuestionSnapshot): void {
  if (typeof output.output !== "string") return
  const answersRaw = (output.metadata as { answers?: readonly (readonly string[])[] } | undefined)?.answers
  const answers = Array.isArray(answersRaw) ? answersRaw : []
  output.output = buildRestoredOutput(snapshot.original, snapshot.translated, answers)
}
