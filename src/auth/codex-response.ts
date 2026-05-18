import { isRecord } from "./codex-shared"

function normalizeCodexOutputItem(item: unknown, index: number): unknown | undefined {
  if (!isRecord(item)) return undefined
  if (item.type !== "message" || item.role !== "assistant") return item
  if (!Array.isArray(item.content)) return undefined

  const content: Record<string, unknown>[] = []
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") continue
    content.push({ ...part, annotations: Array.isArray(part.annotations) ? part.annotations : [] })
  }

  if (content.length === 0) return undefined
  return {
    ...item,
    id: typeof item.id === "string" ? item.id : `msg_opencode_translate_${index}`,
    role: "assistant",
    content,
  }
}

function buildCodexTextOutput(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "msg_opencode_translate_0",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }
}

function parseCodexSSEResponse(text: string): unknown | undefined {
  let finalResponse: unknown
  let deltaText = ""
  const outputItems: unknown[] = []

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice(6).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
        deltaText += parsed.delta
      } else if (
        (parsed.type === "response.output_item.done" || parsed.type === "response.output_item.added") &&
        parsed.item
      ) {
        outputItems.push(parsed.item)
      } else if ((parsed.type === "response.done" || parsed.type === "response.completed") && parsed.response) {
        finalResponse = parsed.response
      }
    } catch {}
  }

  if (!finalResponse && !deltaText && outputItems.length === 0) return undefined
  const response: Record<string, unknown> = isRecord(finalResponse)
    ? { ...finalResponse }
    : { id: "resp_opencode_translate" }
  const existingOutput: unknown[] = Array.isArray(response.output) ? response.output : []
  const sourceOutput = existingOutput.length > 0 ? existingOutput : outputItems
  const normalizedOutput = sourceOutput
    .map((item, index) => normalizeCodexOutputItem(item, index))
    .filter((item): item is unknown => item !== undefined)

  response.output = normalizedOutput.length > 0 ? normalizedOutput : deltaText ? [buildCodexTextOutput(deltaText)] : []
  return response
}

export async function convertCodexSSEToJSON(response: Response): Promise<Response> {
  const headers = new Headers(response.headers)
  const text = await response.text()
  const parsed = parseCodexSSEResponse(text)
  if (!parsed) return new Response(text, { status: response.status, statusText: response.statusText, headers })

  headers.set("content-type", "application/json; charset=utf-8")
  return new Response(JSON.stringify(parsed), { status: response.status, statusText: response.statusText, headers })
}
