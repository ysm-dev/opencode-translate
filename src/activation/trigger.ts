import { isUserAuthoredTextPart, type TextPartLike } from "../constants"
import type { TriggerMatch } from "./types"

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function findTriggerMatch(parts: TextPartLike[], trigger: string[]): TriggerMatch | undefined {
  let eligibleIndex = 0
  for (let partArrayIndex = 0; partArrayIndex < parts.length; partArrayIndex += 1) {
    const part = parts[partArrayIndex]
    if (!isUserAuthoredTextPart(part)) continue

    let bestForPart: TriggerMatch | undefined
    for (const keyword of trigger) {
      const pattern = new RegExp(`(^|[ \\t\\r\\n\\f\\v])${escapeRegex(keyword)}(?=$|[ \\t\\r\\n\\f\\v])`)
      const match = pattern.exec(part.text)
      if (!match) continue
      const offset = match.index + match[1].length
      if (!bestForPart || offset < bestForPart.offset) bestForPart = { partArrayIndex, eligibleIndex, keyword, offset }
    }

    if (bestForPart) return bestForPart
    eligibleIndex += 1
  }

  return undefined
}

export function stripTriggerKeyword(text: string, keyword: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const nextNewline = text.indexOf("\n", offset)
  const lineEnd = nextNewline === -1 ? text.length : nextNewline
  const line = text.slice(lineStart, lineEnd)
  const localOffset = offset - lineStart

  let rewrittenLine: string
  if (localOffset === 0 && line.startsWith(`${keyword} `)) {
    rewrittenLine = line.slice(keyword.length + 1)
  } else if (
    localOffset + keyword.length === line.length &&
    localOffset > 0 &&
    line.slice(localOffset - 1, localOffset) === " "
  ) {
    rewrittenLine = line.slice(0, localOffset - 1)
  } else if (
    localOffset > 0 &&
    line.slice(localOffset - 1, localOffset) === " " &&
    line.slice(localOffset + keyword.length, localOffset + keyword.length + 1) === " "
  ) {
    rewrittenLine = `${line.slice(0, localOffset - 1)} ${line.slice(localOffset + keyword.length + 1)}`
  } else {
    rewrittenLine = `${line.slice(0, localOffset)}${line.slice(localOffset + keyword.length)}`
  }

  return `${text.slice(0, lineStart)}${rewrittenLine}${text.slice(lineEnd)}`
}
