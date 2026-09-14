import { expect, test } from "bun:test"
import { LLM, type LLMEvent } from "@opencode/ai"
import { AnthropicMessages } from "@opencode/ai/protocols/anthropic-messages"
import { Gemini } from "@opencode/ai/protocols/gemini"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { OpenAIResponses } from "@opencode/ai/protocols/openai-responses"
import type { Protocol } from "@opencode/ai/route/protocol"
import { Effect, Schema } from "effect"
import { type Protocol as AdapterProtocol, createAdapter } from "../src/response/protocols"

// Decode the rewritten wire events with OpenCode's real native protocol parsers,
// rather than asserting only against our own representation of an SSE stream.
async function parse<B, E, S>(
  protocol: Protocol<B, string, E, S>,
  adapterProtocol: AdapterProtocol,
  events: unknown[],
) {
  const adapter = createAdapter(adapterProtocol, async (text) => `${text}\n\n번역`)
  const request = LLM.request({
    model: OpenAIResponses.route.model({ id: "test", provider: "openai" }),
    prompt: "Hello",
  })
  let state = protocol.stream.initial(request)
  const results: LLMEvent[] = []
  for (const input of events) {
    for (const frame of await adapter(`data: ${JSON.stringify(input)}`)) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))!
        .slice(5)
        .trim()
      const decoded = Schema.decodeUnknownSync(protocol.stream.event)(data)
      const [next, emitted] = await Effect.runPromise(protocol.stream.step(state, decoded))
      state = next
      results.push(...emitted)
    }
  }
  if (protocol.stream.onHalt) results.push(...(await Effect.runPromise(protocol.stream.onHalt(state))))
  return results
}

test("real Responses parser emits the translated text exactly once and finishes", async () => {
  const item = {
    type: "message",
    role: "assistant",
    id: "item_1",
    status: "completed",
    content: [{ type: "output_text", text: "Hello", annotations: [] }],
  }
  const events = await parse(OpenAIResponses.protocol, "responses", [
    { type: "response.created", response: { id: "resp_1", model: "test", output: [], status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "item_1", output_index: 0, content_index: 0, delta: "Hello" },
    { type: "response.output_text.done", item_id: "item_1", output_index: 0, content_index: 0, text: "Hello" },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ])
  expect(
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Hello\n\n번역")
  expect(events.some((e) => e.type === "finish")).toBe(true)
})
test("real Anthropic parser accepts injected deltas before text block completion", async () => {
  const events = await parse(AnthropicMessages.protocol, "anthropic", [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ])
  expect(
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Hello\n\n번역")
  expect(events.some((e) => e.type === "finish")).toBe(true)
})
test("real Chat parser accepts translation in a final delta", async () => {
  const events = await parse(OpenAIChat.protocol, "chat", [
    { id: "chat_1", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
    {
      id: "chat_1",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ])
  expect(
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Hello\n\n번역")
  expect(events.some((e) => e.type === "finish")).toBe(true)
})
test("real Gemini parser accepts the translated final text part", async () => {
  const events = await parse(Gemini.protocol, "gemini", [
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello" }] } }] },
    {
      candidates: [{ index: 0, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    },
  ])
  expect(
    events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Hello\n\n번역")
  expect(events.some((e) => e.type === "finish")).toBe(true)
})
