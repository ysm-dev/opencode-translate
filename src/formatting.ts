import { FAILURE_NOTICE } from "./constants"

function startMarker(nonce: string) {
  return `<!-- oc-translate:${nonce}:start -->`
}

function endMarker(nonce: string) {
  return `<!-- oc-translate:${nonce}:end -->`
}

function failedMarker(nonce: string) {
  return `<!-- oc-translate:${nonce}:status:failed -->`
}

export function composeTranslatedAssistantText(
  english: string,
  label: string,
  translated: string,
  nonce: string,
): string {
  return `${english}\n\n${startMarker(nonce)}\n---\n\n**${label}:**\n\n${translated}\n${endMarker(nonce)}`
}

export function composeTranslationFailureText(english: string, nonce: string): string {
  return `${english}\n\n${startMarker(nonce)}\n${failedMarker(nonce)}\n---\n\n${FAILURE_NOTICE}\n\n${endMarker(nonce)}`
}

export function extractEnglishHistoryText(text: string, nonce: string): string {
  const lines = text.split("\n")
  const exactEnd = endMarker(nonce)
  const exactStart = startMarker(nonce)
  const exactFailed = failedMarker(nonce)

  let lastNonEmpty = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") {
      lastNonEmpty = index
      break
    }
  }

  if (lastNonEmpty < 0 || lines[lastNonEmpty] !== exactEnd) {
    return text
  }

  let endIndex = -1
  for (let index = lastNonEmpty; index >= 0; index -= 1) {
    if (lines[index] === exactEnd) {
      endIndex = index
      break
    }
  }
  if (endIndex < 0) return text

  let startIndex = -1
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    if (lines[index] === exactStart) {
      startIndex = index
      break
    }
  }
  if (startIndex < 2) return text

  let cursor = startIndex + 1
  const failed = lines[cursor] === exactFailed
  if (failed) cursor += 1

  if (lines[cursor] !== "---") return text
  if (lines[cursor + 1] !== "") return text

  if (failed) {
    if (lines[cursor + 2] !== FAILURE_NOTICE) return text
    if (lines[cursor + 3] !== "") return text
    if (cursor + 4 !== endIndex) return text
  } else {
    const labelLine = lines[cursor + 2]
    if (!/^\*\*.+:\*\*$/.test(labelLine)) return text
    if (lines[cursor + 3] !== "") return text
    if (cursor + 4 > endIndex) return text
  }

  if (lines[startIndex - 1] !== "") return text
  const english = lines.slice(0, startIndex - 1).join("\n")
  return english
}
