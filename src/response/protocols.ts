export type Protocol = "responses" | "chat" | "anthropic" | "gemini"

// This is the text-bearing subset of the four wire formats. JSON is untrusted:
// text edits are guarded, and all unrecognized fields/events are retained.
interface Wire {
  type?: string
  id?: string
  item_id?: string
  index?: number
  output_index?: number
  content_index?: number
  text?: string
  delta?: string | Wire
  content_block?: Wire
  part?: Wire
  item?: Wire & { content?: Wire[] }
  response?: { output?: (Wire & { content?: Wire[] })[] }
  choices?: { index?: number; delta?: { content?: string }; finish_reason?: string | null }[]
  candidates?: {
    index?: number
    content?: { role?: string; parts?: { text?: string; thought?: boolean; thoughtSignature?: string }[] }
    finishReason?: string
  }[]
}

interface Segment {
  english: string
  display?: string
  emitted: string
}

export function createAdapter(protocol: Protocol, translate: (text: string) => Promise<string>) {
  const segments = new Map<string, Segment>()
  const itemIDs = new Map<number, string>()
  function segment(key: string) {
    let value = segments.get(key)
    if (!value) {
      value = { english: "", emitted: "" }
      segments.set(key, value)
    }
    return value
  }
  async function finish(key: string, full?: string) {
    const value = segment(key)
    if (value.display !== undefined) return value
    if (typeof full === "string") value.english = full
    if (!value.english.startsWith(value.emitted)) {
      value.display = value.english
      return value
    }
    value.display = value.english ? await translate(value.english) : ""
    return value
  }
  function delta(key: string, text: string) {
    const value = segment(key)
    value.english += text
    value.emitted += text
  }
  function suffix(value: Segment) {
    // A provider's authoritative final may disagree with streamed deltas. Never
    // attempt a destructive edit to text already displayed by OpenCode.
    if (!value.display?.startsWith(value.emitted)) return ""
    const result = value.display.slice(value.emitted.length)
    value.emitted = value.display
    return result
  }
  return async (frame: string): Promise<string[]> => {
    const lines = frame.split(/\r\n|\r|\n/)
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
    if (!data || data === "[DONE]") return [frame]
    let event: Wire
    try {
      const parsed: unknown = JSON.parse(data)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [frame]
      event = parsed as Wire
    } catch {
      return [frame]
    }
    const extra: string[] = []
    let changed = false
    function emit(value: Wire) {
      extra.push(`${value.type ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}`)
    }

    if (protocol === "anthropic") {
      const key = String(event.index ?? 0)
      if (
        event.type === "content_block_start" &&
        event.content_block?.type === "text" &&
        typeof event.content_block.text === "string"
      )
        delta(key, event.content_block.text)
      if (
        event.type === "content_block_delta" &&
        typeof event.delta === "object" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string"
      )
        delta(key, event.delta.text)
      if (event.type === "content_block_stop" && segments.has(key)) {
        const text = suffix(await finish(key))
        if (text) emit({ type: "content_block_delta", index: event.index, delta: { type: "text_delta", text } })
      }
    }

    if (protocol === "chat" && Array.isArray(event.choices)) {
      for (const choice of event.choices) {
        const key = String(choice.index ?? 0)
        if (typeof choice.delta?.content === "string") delta(key, choice.delta.content)
        if (choice.finish_reason && segments.has(key)) {
          // Keep the final chunk's own delta before the translation, but don't
          // close the choice until the trailer has been emitted.
          const text = suffix(await finish(key))
          if (text) {
            choice.delta = { ...choice.delta, content: `${choice.delta?.content ?? ""}${text}` }
            changed = true
          }
        }
      }
    }

    if (protocol === "gemini" && Array.isArray(event.candidates)) {
      for (const candidate of event.candidates) {
        const key = String(candidate.index ?? 0)
        for (const part of candidate.content?.parts ?? []) {
          if (typeof part.text === "string" && part.thought !== true) delta(key, part.text)
        }
        if (candidate.finishReason && segments.has(key)) {
          const text = suffix(await finish(key))
          if (text) {
            // Preserve thought signatures and tool/media parts on their original
            // parts. Only the added plain-text part is plugin-generated.
            candidate.content = { ...candidate.content, parts: [...(candidate.content?.parts ?? []), { text }] }
            changed = true
          }
        }
      }
    }

    if (protocol === "responses") {
      if (event.item?.id && event.output_index !== undefined) itemIDs.set(event.output_index, event.item.id)
      const resolvedID = event.item_id ?? itemIDs.get(event.output_index ?? 0)
      const key = `${resolvedID ?? event.output_index ?? 0}/${event.content_index ?? 0}`
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") delta(key, event.delta)
      async function complete(itemID: string | number, index: number, text: string, outputIndex?: number) {
        const value = await finish(`${itemID}/${index}`, text)
        const addition = suffix(value)
        if (addition)
          emit({
            type: "response.output_text.delta",
            item_id: String(itemID),
            output_index: outputIndex,
            content_index: index,
            delta: addition,
          })
        return value.display ?? text
      }
      if (event.type === "response.output_text.done" && typeof event.text === "string") {
        event.text = await complete(
          resolvedID ?? event.output_index ?? 0,
          event.content_index ?? 0,
          event.text,
          event.output_index,
        )
        changed = true
      }
      if (
        event.type === "response.content_part.done" &&
        event.part?.type === "output_text" &&
        typeof event.part.text === "string"
      ) {
        event.part.text = await complete(
          resolvedID ?? event.output_index ?? 0,
          event.content_index ?? 0,
          event.part.text,
          event.output_index,
        )
        changed = true
      }
      async function item(value: Wire & { content?: Wire[] }, outputIndex?: number) {
        if (value.type !== "message" || !Array.isArray(value.content)) return
        for (const [index, part] of value.content.entries()) {
          if (part.type !== "output_text" || typeof part.text !== "string") continue
          part.text = await complete(value.id ?? outputIndex ?? 0, index, part.text, outputIndex)
          changed = true
        }
      }
      if (event.type === "response.output_item.done" && event.item) await item(event.item, event.output_index)
      if (
        (event.type === "response.completed" || event.type === "response.incomplete") &&
        Array.isArray(event.response?.output)
      ) {
        for (const [index, value] of event.response.output.entries()) await item(value, index)
      }
    }
    if (!changed) return [...extra, frame]
    const headers = lines.filter((line) => !line.startsWith("data:"))
    return [...extra, [...headers, `data: ${JSON.stringify(event)}`].join("\n")]
  }
}
