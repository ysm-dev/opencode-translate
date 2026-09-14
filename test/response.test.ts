import { describe, expect, test } from "bun:test"
import { setup } from "../src/activation"
import { composeTranslatedAssistantText } from "../src/formatting"
import { getDisplayLanguageLabel } from "../src/labels"
import { type ResponseTranslation, translateResponse } from "../src/response"
import { host, prompt, requestContext } from "./helpers"

function sse(events: unknown[], newline = "\n") {
  return events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}${newline}${newline}`)
    .join("")
}
function source(text: string, split = 1) {
  const bytes = new TextEncoder().encode(text)
  let index = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index >= bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(index, index + split))
        index += split
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-original": "preserved",
        "content-length": String(bytes.length),
      },
    },
  )
}
function output(text: string) {
  return text.split(/\n\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    return !data || data === "[DONE]" ? [] : [JSON.parse(data)]
  })
}
function translation(overrides: Partial<ResponseTranslation> = {}) {
  const calls: string[] = []
  const records = new Map<string, string>()
  const warnings: string[] = []
  const options: ResponseTranslation = {
    lang: "Korean",
    signal: new AbortController().signal,
    translate: async (text) => {
      calls.push(text)
      return `번역:${text}`
    },
    remember: async (display, english) => {
      records.set(display, english)
    },
    warn: (message) => {
      warnings.push(message)
    },
    ...overrides,
  }
  return { options, calls, records, warnings }
}
const bilingual = (english: string) =>
  composeTranslatedAssistantText(english, getDisplayLanguageLabel("Korean"), `번역:${english}`)

describe("native response adapters", () => {
  test("Responses keeps deltas and every final snapshot consistent without duplicate translations", async () => {
    const t = translation()
    const item = { type: "message", id: "item_1", content: [{ type: "output_text", text: "Hello" }] }
    const wire = sse(
      [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", item_id: "item_1", output_index: 0, content_index: 0, delta: "Hel" },
        { type: "response.output_text.delta", item_id: "item_1", output_index: 0, content_index: 0, delta: "lo" },
        { type: "response.output_text.done", item_id: "item_1", output_index: 0, content_index: 0, text: "Hello" },
        {
          type: "response.content_part.done",
          item_id: "item_1",
          output_index: 0,
          content_index: 0,
          part: item.content[0],
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_1", output: [item], usage: { output_tokens: 3 } } },
        "[DONE]",
      ],
      "\r\n",
    )
    const response = translateResponse(
      new Request("https://chatgpt.com/backend-api/codex/responses"),
      source(wire),
      t.options,
    )
    const events = output(await response.text())
    expect(
      events
        .filter((e) => e.type === "response.output_text.delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe(bilingual("Hello"))
    expect(events.find((e) => e.type === "response.output_text.done").text).toBe(bilingual("Hello"))
    expect(events.find((e) => e.type === "response.content_part.done").part.text).toBe(bilingual("Hello"))
    expect(events.find((e) => e.type === "response.output_item.done").item.content[0].text).toBe(bilingual("Hello"))
    expect(events.at(-1).response.output[0].content[0].text).toBe(bilingual("Hello"))
    expect(events.at(-1).response.usage).toEqual({ output_tokens: 3 })
    expect(t.calls).toEqual(["Hello"])
    expect(t.records.get(bilingual("Hello"))).toBe("Hello")
    expect(response.headers.get("x-original")).toBe("preserved")
    expect(response.headers.has("content-length")).toBe(false)
  })
  test("Responses handles snapshot-only text and leaves reasoning and function arguments intact", async () => {
    const t = translation()
    const reasoning = {
      type: "reasoning",
      id: "reason_1",
      encrypted_content: "opaque",
      summary: [{ type: "summary_text", text: "reason" }],
    }
    const tool = { type: "function_call", id: "tool_1", arguments: '{"text":"Hello"}' }
    const text = { type: "message", id: "item_1", content: [{ type: "output_text", text: "Hello" }] }
    const response = translateResponse(
      new Request("https://api.example/v1/responses"),
      source(sse([{ type: "response.completed", response: { output: [reasoning, tool, text] } }])),
      t.options,
    )
    const events = output(await response.text())
    expect(events.at(-1).response.output.slice(0, 2)).toEqual([reasoning, tool])
    expect(events.at(-1).response.output[2].content[0].text).toBe(bilingual("Hello"))
    expect(t.calls).toEqual(["Hello"])
  })
  test("Anthropic appends before block stop, preserving signatures and tool input", async () => {
    const t = translation()
    const untouched = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "signed" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reason" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool_1", name: "read", input: {} },
      },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"file"}' } },
      { type: "content_block_stop", index: 2 },
    ]
    const response = translateResponse(
      new Request("https://api.anthropic.com/v1/messages"),
      source(
        sse([
          ...untouched,
          { type: "content_block_start", index: 3, content_block: { type: "text", text: "Hi " } },
          { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "世界" } },
          { type: "content_block_stop", index: 3 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } },
          { type: "message_stop" },
        ]),
      ),
      t.options,
    )
    const events = output(await response.text())
    expect(events.slice(0, untouched.length)).toEqual(untouched)
    const block = events.filter((e) => e.index === 3)
    expect(
      block[0].content_block.text +
        block
          .filter((e) => e.type === "content_block_delta")
          .map((e) => e.delta.text)
          .join(""),
    ).toBe(bilingual("Hi 世界"))
    expect(block.at(-1).type).toBe("content_block_stop")
    expect(t.calls).toEqual(["Hi 世界"])
  })
  test("Chat handles parallel choices, final deltas, tool calls and usage-only frames", async () => {
    const t = translation()
    const tool = {
      index: 1,
      delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
      finish_reason: "tool_calls",
    }
    const response = translateResponse(
      new Request("https://azure.example/openai/deployments/model/chat/completions?api-version=1"),
      source(
        sse([
          { id: "chat_1", choices: [{ index: 0, delta: { content: "Hel", reasoning_content: "Reason" } }] },
          { id: "chat_1", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }, tool] },
          { choices: [], usage: { completion_tokens: 2 } },
          "[DONE]",
        ]),
      ),
      t.options,
    )
    const events = output(await response.text())
    expect(events[0].choices[0].delta.reasoning_content).toBe("Reason")
    expect(events[0].choices[0].delta.content + events[1].choices[0].delta.content).toBe(bilingual("Hello"))
    expect(events[1].choices[1]).toEqual(tool)
    expect(events[1].choices[0].finish_reason).toBe("stop")
    expect(events[2].usage.completion_tokens).toBe(2)
  })
  test("Gemini preserves thought signatures, media and function calls", async () => {
    const t = translation()
    const thought = { text: "Thinking", thought: true, thoughtSignature: "signed" }
    const tool = { functionCall: { name: "read", args: {} }, thoughtSignature: "tool-signature" }
    const response = translateResponse(
      new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini:streamGenerateContent?alt=sse"),
      source(
        sse([
          { candidates: [{ index: 0, content: { role: "model", parts: [thought, { text: "Hello" }] } }] },
          {
            candidates: [{ index: 0, content: { role: "model", parts: [tool] }, finishReason: "STOP" }],
            usageMetadata: { candidatesTokenCount: 10 },
          },
        ]),
      ),
      t.options,
    )
    const events = output(await response.text())
    expect(events[0].candidates[0].content.parts[0]).toEqual(thought)
    expect(events[1].candidates[0].content.parts[0]).toEqual(tool)
    expect(`Hello${events[1].candidates[0].content.parts[1].text}`).toBe(bilingual("Hello"))
    expect(events[1].usageMetadata.candidatesTokenCount).toBe(10)
  })
  test("translation failure preserves English and records the failure trailer for filtering", async () => {
    const t = translation({
      translate: async () => {
        throw new Error("unavailable")
      },
    })
    const response = translateResponse(
      new Request("https://api.example/v1/chat/completions"),
      source(sse([{ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] }])),
      t.options,
    )
    const text = output(await response.text())[0].choices[0].delta.content
    expect(text).toStartWith("Hello\n\n---")
    expect(text).toContain("Translation unavailable")
    expect(t.records.get(text)).toBe("Hello")
  })
  test("storage failure does not emit an untracked translation", async () => {
    const t = translation({
      remember: async () => {
        throw new Error("disk full")
      },
    })
    const response = translateResponse(
      new Request("https://api.example/v1/chat/completions"),
      source(sse([{ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }])),
      t.options,
    )
    expect(output(await response.text())[0].choices[0].delta.content).toBe("Hello")
    expect(t.warnings.join()).toContain("disk full")
  })
  test("unknown and non-SSE protocols pass through without consuming their body", async () => {
    const t = translation()
    for (const [url, type] of [
      ["https://bedrock.example/model/model/converse-stream", "application/vnd.amazon.eventstream"],
      ["https://api.example/v1/responses", "application/json"],
    ]) {
      const original = new Response("original", { headers: { "content-type": type } })
      expect(translateResponse(new Request(url), original, t.options)).toBe(original)
      expect(original.bodyUsed).toBe(false)
    }
    expect(t.calls).toHaveLength(0)
  })
  test("incomplete streams are not manufactured into successful completions", async () => {
    const t = translation()
    const wire = `${sse([{ choices: [{ delta: { content: "partial" } }] }])}data: {"unfinished"`
    const response = translateResponse(new Request("https://api.example/v1/chat/completions"), source(wire), t.options)
    expect(await response.text()).toBe(wire)
    expect(t.calls).toHaveLength(0)
  })
  test("English streams before translation is requested", async () => {
    const t = translation()
    const wire = sse([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ])
    const response = translateResponse(new Request("https://api.example/v1/chat/completions"), source(wire), t.options)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("Hello")
    expect(t.calls).toHaveLength(0)
    await reader.cancel()
  })
  test("request cancellation closes the upstream stream", async () => {
    let cancelled = false
    const controller = new AbortController()
    const original = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const response = translateResponse(
      new Request("https://api.example/v1/responses", { signal: controller.signal }),
      original,
      translation().options,
    )
    const pending = response.text()
    controller.abort(new Error("stopped"))
    await expect(pending).rejects.toThrow("stopped")
    expect(cancelled).toBe(true)
  })
  test("upstream cancellation errors do not replace the caller's abort reason", async () => {
    const controller = new AbortController()
    const original = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("upstream cancel failed")
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const response = translateResponse(
      new Request("https://api.example/v1/responses", { signal: controller.signal }),
      original,
      translation().options,
    )
    const pending = response.text()
    controller.abort(new Error("user stopped"))
    await expect(pending).rejects.toThrow("user stopped")
  })
  test("upstream read failures propagate without being replaced by cleanup errors", async () => {
    const original = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("provider connection lost"))
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
    const t = translation()
    const response = translateResponse(new Request("https://api.example/v1/responses"), original, t.options)
    await expect(response.text()).rejects.toThrow("provider connection lost")
    expect(t.calls).toHaveLength(0)
  })
  test("full v2 hook flow persists bilingual response but restores English for the next request", async () => {
    const h = host()
    h.generate(async (input) => (input.includes("from Korean") ? "Hello" : "안녕"))
    const cleanup = await setup(h.ctx)
    await h.emit("session.prompt", prompt())
    const original = source(sse([{ choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] }]))
    const event = {
      kind: "primary",
      sessionID: "ses_1",
      request: new Request("https://api.example/v1/chat/completions"),
      response: original,
    }
    await h.emit("session.http.response", event)
    const display = output(await event.response.text())[0].choices[0].delta.content
    expect(display).toContain("안녕")
    const context = requestContext([{ role: "assistant", content: [{ type: "text", text: display }] }])
    await h.emit("session.context", context)
    expect(context.messages).toMatchObject([{ content: [{ text: "Hello" }] }])
    const title = { ...event, kind: "title", response: original }
    await h.emit("session.http.response", title)
    expect(title.response).toBe(original)
    cleanup?.()
  })
})
