import { isRecord } from "./codex-shared"
import type { CodexBodyRewrite } from "./types"

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined

  const text = content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : undefined))
    .filter((value): value is string => value !== undefined)
    .join("\n")

  return text || undefined
}

function normalizeCodexContent(role: string, content: unknown): Record<string, unknown>[] {
  const textType = role === "assistant" ? "output_text" : "input_text"
  if (typeof content === "string") return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return []

  const result: Record<string, unknown>[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const type = part.type
    if (type === "input_text" || type === "output_text") {
      result.push({ ...part, type: textType })
      continue
    }
    if (type === "input_image") {
      result.push({ ...part })
      continue
    }
    if (typeof part.text === "string") result.push({ type: textType, text: part.text })
  }

  return result
}

function normalizeCodexInputItem(item: unknown, instructions: string[]): unknown | undefined {
  if (!isRecord(item)) return item
  const role = typeof item.role === "string" ? item.role : undefined

  if (role === "system" || role === "developer") {
    const text = textFromContent(item.content)
    if (text) instructions.push(text)
    return undefined
  }

  if (item.type === "message" && role) {
    const content = normalizeCodexContent(role, item.content)
    return content.length > 0 ? { ...item, role, content } : undefined
  }

  if (role) {
    const content = normalizeCodexContent(role, item.content)
    return content.length > 0 ? { type: "message", role, content } : undefined
  }

  return item
}

export function rewriteOpenAICodexBody(body: BodyInit | null | undefined): CodexBodyRewrite {
  if (typeof body !== "string") return { body, originalStream: false }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { body, originalStream: false }
  }

  if (!isRecord(parsed)) return { body, originalStream: false }
  const originalStream = parsed.stream === true
  const sourceInput = Array.isArray(parsed.input)
    ? parsed.input
    : Array.isArray(parsed.messages)
      ? parsed.messages
      : undefined
  if (!sourceInput) return { body, originalStream }

  const instructions: string[] = []
  if (typeof parsed.instructions === "string" && parsed.instructions) instructions.push(parsed.instructions)
  const input = sourceInput
    .map((item) => normalizeCodexInputItem(item, instructions))
    .filter((item): item is unknown => item !== undefined)
  const include = Array.isArray(parsed.include)
    ? parsed.include.filter((item): item is string => typeof item === "string")
    : []
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content")

  return {
    body: JSON.stringify({
      ...parsed,
      instructions: instructions.join("\n\n"),
      input,
      tools: Array.isArray(parsed.tools) ? parsed.tools : [],
      tool_choice: typeof parsed.tool_choice === "string" ? parsed.tool_choice : "auto",
      parallel_tool_calls: typeof parsed.parallel_tool_calls === "boolean" ? parsed.parallel_tool_calls : false,
      store: false,
      stream: true,
      include,
      max_output_tokens: undefined,
      max_completion_tokens: undefined,
      messages: undefined,
    }),
    originalStream,
  }
}
