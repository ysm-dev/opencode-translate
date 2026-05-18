import { describe, expect, test } from "bun:test"
import { rewriteOpenAICodexBody } from "../../src/auth/codex-request"
import { convertCodexSSEToJSON } from "../../src/auth/codex-response"

describe("OpenAI Codex request rewriting", () => {
  test("passes through bodies that cannot be rewritten", () => {
    expect(rewriteOpenAICodexBody(undefined)).toEqual({ body: undefined, originalStream: false })
    expect(rewriteOpenAICodexBody("{not json")).toEqual({ body: "{not json", originalStream: false })

    const arrayBody = JSON.stringify([])
    expect(rewriteOpenAICodexBody(arrayBody)).toEqual({ body: arrayBody, originalStream: false })

    const streamOnly = JSON.stringify({ stream: true })
    expect(rewriteOpenAICodexBody(streamOnly)).toEqual({ body: streamOnly, originalStream: true })
  })

  test("normalizes mixed Responses input into Codex message items", () => {
    const rewritten = rewriteOpenAICodexBody(
      JSON.stringify({
        instructions: "base instructions",
        stream: false,
        input: [
          { role: "system", content: [{ text: "system instructions" }, { type: "image" }] },
          { role: "developer", content: "developer instructions" },
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "hello" },
              { type: "input_image", image_url: "data:image/png;base64,abc" },
              { type: "other", text: "fallback text" },
              { type: "other" },
            ],
          },
          { role: "assistant", content: [{ type: "input_text", text: "answer" }] },
          { role: "user", content: { not: "array" } },
          "passthrough",
        ],
        include: ["existing.include", 123],
        tools: [{ type: "function" }],
        tool_choice: "none",
        parallel_tool_calls: true,
        max_output_tokens: 42,
      }),
    )

    const parsed = JSON.parse(String(rewritten.body)) as Record<string, unknown>
    expect(rewritten.originalStream).toBe(false)
    expect(parsed.instructions).toBe("base instructions\n\nsystem instructions\n\ndeveloper instructions")
    expect(parsed.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "hello" },
          { type: "input_image", image_url: "data:image/png;base64,abc" },
          { type: "input_text", text: "fallback text" },
        ],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      "passthrough",
    ])
    expect(parsed.include).toEqual(["existing.include", "reasoning.encrypted_content"])
    expect(parsed.tools).toEqual([{ type: "function" }])
    expect(parsed.tool_choice).toBe("none")
    expect(parsed.parallel_tool_calls).toBe(true)
    expect(parsed.store).toBe(false)
    expect(parsed.stream).toBe(true)
    expect(parsed.max_output_tokens).toBeUndefined()
  })
})

describe("OpenAI Codex SSE conversion", () => {
  test("normalizes output items from SSE into JSON responses", async () => {
    const response = await convertCodexSSEToJSON(
      new Response(
        [
          "data: {not json}\n\n",
          `data: ${JSON.stringify({ type: "response.output_item.done", item: "bad" })}\n\n`,
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            item: {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "hello", annotations: [{ type: "url" }] },
                { type: "output_text", text: 123 },
                { type: "input_text", text: "ignored" },
              ],
            },
          })}\n\n`,
          `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "reasoning", summary: [] } })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { status: 201, statusText: "Created", headers: { "Content-Type": "text/event-stream" } },
      ),
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({
      id: "resp_opencode_translate",
      output: [
        {
          type: "message",
          id: "msg_opencode_translate_1",
          role: "assistant",
          content: [{ type: "output_text", text: "hello", annotations: [{ type: "url" }] }],
        },
        { type: "reasoning", summary: [] },
      ],
    })
  })

  test("returns the original SSE response when no Codex events are found", async () => {
    const response = await convertCodexSSEToJSON(
      new Response("event: ping\ndata: \n\n", {
        status: 202,
        statusText: "Accepted",
        headers: { "Content-Type": "text/event-stream", "x-test": "kept" },
      }),
    )

    expect(response.status).toBe(202)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-test")).toBe("kept")
    expect(await response.text()).toBe("event: ping\ndata: \n\n")
  })
})
