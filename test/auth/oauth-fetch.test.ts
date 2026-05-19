import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetAuthCachesForTest, createCredentialResolver } from "../../src/auth"
import { resolveOptions } from "../../src/constants"
import { fakeClient } from "./helpers"

beforeEach(() => {
  __resetAuthCachesForTest()
  process.env.OPENCODE_AUTH_CONTENT = "{}"
})

afterEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
})

test("Anthropic OAuth request headers are adapted correctly", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
  })
  let finalUrl = ""
  let finalHeaders = new Headers()
  const resolver = createCredentialResolver(
    fakeClient([{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ model: "anthropic/claude-haiku-4-5", lang: "Korean" }),
    {
      fetchImpl: async (input, init) => {
        finalUrl = input instanceof URL ? input.href : String(input)
        finalHeaders = new Headers(init?.headers)
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
  await resolved.fetch!("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": "dummy" } })

  expect(finalUrl).toContain("?beta=true")
  expect(finalHeaders.get("Authorization")).toBe("Bearer access-token")
  expect(finalHeaders.get("anthropic-beta")).toContain("oauth-2025-04-20")
  expect(finalHeaders.get("anthropic-version")).toBe("2023-06-01")
  expect(finalHeaders.get("x-api-key")).toBeNull()
})

test("Anthropic OAuth rewrites messages request bodies", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
  })
  let finalBody = ""
  const resolver = createCredentialResolver(
    fakeClient([{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ model: "anthropic/claude-haiku-4-5", lang: "Korean" }),
    {
      fetchImpl: async (_input, init) => {
        finalBody = String(init?.body)
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
  await resolved.fetch!("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ system: "translator", messages: [{ role: "user", content: "안녕" }] }),
  })

  const parsed = JSON.parse(finalBody) as { system: Array<{ text: string }> }
  expect(parsed.system[0].text).toContain("x-anthropic-billing-header")
  expect(parsed.system[1].text).toContain("Claude agent")
  expect(parsed.system[2].text).toBe("translator")
})

test("OpenAI OAuth rewrites Responses requests to Codex request shape", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3600_000,
      accountId: "acct_1",
    },
  })
  let finalUrl = ""
  let finalHeaders = new Headers()
  let finalBody = ""
  const resolver = createCredentialResolver(
    fakeClient([{ id: "openai", source: "custom", env: ["OPENAI_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ model: "openai/gpt-5.5", lang: "Korean" }),
    {
      fetchImpl: async (input, init) => {
        finalUrl = input instanceof URL ? input.href : String(input)
        finalHeaders = new Headers(init?.headers)
        finalBody = String(init?.body)
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("openai/gpt-5.5")
  await resolved.fetch!("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "translator instructions" },
        { role: "user", content: [{ type: "input_text", text: "<text>\n안녕\n</text>" }] },
      ],
    }),
  })

  const parsed = JSON.parse(finalBody) as Record<string, unknown>
  expect(finalUrl).toBe("https://chatgpt.com/backend-api/codex/responses")
  expect(finalHeaders.get("Authorization")).toBe("Bearer access-token")
  expect(finalHeaders.get("ChatGPT-Account-Id")).toBe("acct_1")
  expect(finalHeaders.get("OpenAI-Beta")).toBe("responses=experimental")
  expect(finalHeaders.get("originator")).toBe("codex_cli_rs")
  expect(finalHeaders.get("accept")).toBe("text/event-stream")
  expect(parsed.instructions).toBe("translator instructions")
  expect(parsed.messages).toBeUndefined()
  expect(parsed.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "<text>\n안녕\n</text>" }] },
  ])
  expect(parsed.tools).toEqual([])
  expect(parsed.tool_choice).toBe("auto")
  expect(parsed.parallel_tool_calls).toBe(false)
  expect(parsed.store).toBe(false)
  expect(parsed.stream).toBe(true)
  expect(parsed.include).toEqual(["reasoning.encrypted_content"])
})

test("OpenAI OAuth converts Codex SSE responses back to JSON for generateText", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
  })
  const resolver = createCredentialResolver(
    fakeClient([{ id: "openai", source: "custom", env: ["OPENAI_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ model: "openai/gpt-5.5", lang: "Korean" }),
    {
      fetchImpl: async () =>
        new Response(
          [
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("openai/gpt-5.5")
  const response = await resolved.fetch!("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }),
  })

  expect(response.headers.get("content-type")).toContain("application/json")
  expect(await response.json()).toEqual({
    id: "resp_1",
    output: [
      {
        type: "message",
        id: "msg_opencode_translate_0",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  })
})

test("OpenAI OAuth rewrites Chat Completions messages to Codex request shape", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
  })
  let finalBody = ""
  const resolver = createCredentialResolver(
    fakeClient([{ id: "openai", source: "custom", env: ["OPENAI_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ model: "openai/gpt-5.5", lang: "Korean" }),
    {
      fetchImpl: async (_input, init) => {
        finalBody = String(init?.body)
        return new Response("{}", { status: 200 })
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("openai/gpt-5.5")
  await resolved.fetch!("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "system instructions" },
        { role: "user", content: "안녕" },
        { role: "assistant", content: "hello" },
      ],
    }),
  })

  const parsed = JSON.parse(finalBody) as Record<string, unknown>
  expect(parsed.instructions).toBe("system instructions")
  expect(parsed.messages).toBeUndefined()
  expect(parsed.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "안녕" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
  ])
})

test("OpenAI OAuth leaves non-OpenAI API URLs on the normal fetch path", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
  })
  let finalUrl = ""
  let finalBody = ""
  const resolver = createCredentialResolver(
    fakeClient([{ id: "openai", source: "custom", env: ["OPENAI_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ model: "openai/gpt-5.5", lang: "Korean" }),
    {
      fetchImpl: async (input, init) => {
        finalUrl = input instanceof URL ? input.href : String(input)
        finalBody = String(init?.body)
        return new Response("plain", { status: 200, headers: { "Content-Type": "text/plain" } })
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("openai/gpt-5.5")
  const response = await resolved.fetch!("https://api.openai.com/v1/models", {
    method: "POST",
    body: "original-body",
  })

  expect(finalUrl).toBe("https://api.openai.com/v1/models")
  expect(finalBody).toBe("original-body")
  expect(await response.text()).toBe("plain")
})

test("GitHub Copilot OAuth exchanges a session token and rewrites enterprise hosts", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    "github-copilot": {
      type: "oauth",
      access: "unused-access",
      refresh: "github-refresh-token",
      expires: Date.now() + 3600_000,
      enterpriseUrl: "https://copilot.example.test:8443",
    },
  })
  const calls: Array<{ url: string; headers: Headers }> = []
  const resolver = createCredentialResolver(
    fakeClient([
      {
        id: "github-copilot",
        source: "custom",
        env: ["GITHUB_COPILOT_API_KEY"],
        key: "opencode-oauth-dummy-key",
      },
    ]),
    resolveOptions({ model: "github-copilot/gpt-4o", lang: "Korean" }),
    {
      packageVersion: "9.9.9",
      fetchImpl: async (input, init) => {
        const url = input instanceof URL ? input.href : String(input)
        calls.push({ url, headers: new Headers(init?.headers) })
        if (url === "https://api.github.com/copilot_internal/v2/token") {
          return new Response(JSON.stringify({ token: "copilot-session-token" }), { status: 200 })
        }
        return new Response("ok", { status: 200 })
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("github-copilot/gpt-4o")
  await resolved.fetch!("https://api.githubcopilot.com/chat/completions", { headers: { "x-api-key": "remove-me" } })

  expect(calls[0].url).toBe("https://api.github.com/copilot_internal/v2/token")
  expect(calls[0].headers.get("Authorization")).toBe("token github-refresh-token")
  expect(calls[1].url).toBe("https://copilot.example.test:8443/chat/completions")
  expect(calls[1].headers.get("Authorization")).toBe("Bearer copilot-session-token")
  expect(calls[1].headers.get("Editor-Version")).toBe("opencode-translate/9.9.9")
  expect(calls[1].headers.get("Editor-Plugin-Version")).toBe("opencode-translate/9.9.9")
  expect(calls[1].headers.get("Copilot-Integration-Id")).toBe("vscode-chat")
  expect(calls[1].headers.get("x-api-key")).toBeNull()
})
