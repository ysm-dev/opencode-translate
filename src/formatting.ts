import { FAILURE_NOTICE } from "./constants"

// Visible bilingual trailer structure (no invisible delimiters):
//
//   <english>
//
//   ---
//
//   **<label>:**
//
//   <translated>
//
// Failure variant:
//
//   <english>
//
//   ---
//
//   _Translation unavailable for this segment._
//
// The structure renders cleanly under every Markdown front-end we ship to
// (web `marked`, OpenTUI `<markdown>`, plain text). The history transform
// recognises it by walking the trailing `---` separator backwards through the
// stored text and matching the exact label (or failure notice) the plugin
// emitted for the active session.

const SEPARATOR_LINE = "---"

interface ExtractContext {
  /** Activation nonce. Used only by the legacy marker fallback. */
  nonce: string
  /** Display language label used when composing assistant text. */
  label: string
}

export function composeTranslatedAssistantText(english: string, label: string, translated: string): string {
  return `${english}\n\n${SEPARATOR_LINE}\n\n**${label}:**\n\n${translated}`
}

export function composeTranslationFailureText(english: string): string {
  return `${english}\n\n${SEPARATOR_LINE}\n\n${FAILURE_NOTICE}`
}

export function extractEnglishHistoryText(text: string, ctx: ExtractContext): string {
  const legacy = extractLegacyMarkerTrailer(text, ctx.nonce)
  if (legacy !== null) return legacy

  const structural = extractStructuralTrailer(text, ctx.label)
  if (structural !== null) return structural

  return text
}

function extractStructuralTrailer(text: string, label: string): string | null {
  const labelLine = `**${label}:**`
  const lines = text.split("\n")

  // Ignore trailing blank lines so a final `\n` (or several) does not throw
  // off the structural match.
  let endLine = lines.length - 1
  while (endLine >= 0 && lines[endLine] === "") endLine -= 1

  // Smallest valid failure trailer is 5 lines: english, "", ---, "", FAILURE.
  if (endLine < 4) return null

  // Walk backwards: the trailer's `---` is always preceded by exactly one
  // blank line and a non-empty English half, and followed by exactly one
  // blank line plus either the label line or the failure notice extending
  // to the end of `text`.
  for (let i = endLine; i >= 2; i -= 1) {
    if (lines[i] !== SEPARATOR_LINE) continue
    if (lines[i - 1] !== "") continue
    if (i - 2 < 0) continue
    if (i + 2 > endLine) continue
    if (lines[i + 1] !== "") continue

    const headLine = lines[i + 2]

    if (headLine === labelLine) {
      // Success trailer: `**label:**\n\n<translated...>` extending to end.
      if (i + 3 > endLine) continue
      if (lines[i + 3] !== "") continue
      // Translated content occupies lines i+4..endLine and must be non-empty.
      if (i + 4 > endLine) continue
      return lines.slice(0, i - 1).join("\n")
    }

    if (headLine === FAILURE_NOTICE) {
      // Failure trailer ends exactly at the notice.
      if (i + 2 !== endLine) continue
      return lines.slice(0, i - 1).join("\n")
    }
  }

  return null
}

// Legacy fallback. Earlier versions of the plugin stored bilingual assistant
// text wrapped in `<!-- oc-translate:{nonce}:start -->` ... `<!-- oc-translate:{nonce}:end -->`
// HTML comments. Those comments render cleanly in the web UI but show up as
// literal text in the terminal UI, which is the bug this refactor fixes.
// We keep parsing them so existing sessions continue to feed English-only
// history to the LLM after the plugin is upgraded.
function extractLegacyMarkerTrailer(text: string, nonce: string): string | null {
  const lines = text.split("\n")
  const exactStart = `<!-- oc-translate:${nonce}:start -->`
  const exactEnd = `<!-- oc-translate:${nonce}:end -->`
  const exactFailed = `<!-- oc-translate:${nonce}:status:failed -->`

  let lastNonEmpty = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") {
      lastNonEmpty = index
      break
    }
  }
  if (lastNonEmpty < 0 || lines[lastNonEmpty] !== exactEnd) return null

  let endIndex = -1
  for (let index = lastNonEmpty; index >= 0; index -= 1) {
    if (lines[index] === exactEnd) {
      endIndex = index
      break
    }
  }
  if (endIndex < 0) return null

  let startIndex = -1
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (lines[index] === exactStart) {
      startIndex = index
      break
    }
  }
  if (startIndex < 2) return null

  let cursor = startIndex + 1
  const failed = lines[cursor] === exactFailed
  if (failed) cursor += 1

  if (lines[cursor] !== SEPARATOR_LINE) return null
  if (lines[cursor + 1] !== "") return null

  if (failed) {
    if (lines[cursor + 2] !== FAILURE_NOTICE) return null
    if (lines[cursor + 3] !== "") return null
    if (cursor + 4 !== endIndex) return null
  } else {
    const labelLine = lines[cursor + 2]
    if (!/^\*\*.+:\*\*$/.test(labelLine)) return null
    if (lines[cursor + 3] !== "") return null
    if (cursor + 4 > endIndex) return null
  }

  if (lines[startIndex - 1] !== "") return null
  return lines.slice(0, startIndex - 1).join("\n")
}
