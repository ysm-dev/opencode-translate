import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetAuthCachesForTest, createCredentialResolver } from "../src/auth"
import { type PluginClientLike, type ProviderInfo, resolveOptions } from "../src/constants"

function fakeClient(providers: ProviderInfo[], authSetCalls: unknown[] = []): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID: null }),
      messages: async () => [],
      message: async () => ({ info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [] }),
    },
    provider: {
      list: async () => ({ all: providers }),
    },
    auth: {
      set: async (input) => {
        authSetCalls.push(input)
        return undefined
      },
    },
    app: {
      log: async () => undefined,
    },
  }
}

describe("auth", () => {
  beforeEach(() => {
    __resetAuthCachesForTest()
    // Force an empty auth map by default so tests never read the developer's real auth.json.
    // Individual tests that need OAuth records reassign this env var explicitly.
    process.env.OPENCODE_AUTH_CONTENT = "{}"
  })

  afterEach(() => {
    delete process.env.OPENCODE_AUTH_CONTENT
  })

  test("options.apiKey takes precedence over provider keys", async () => {
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "api",
          env: ["ANTHROPIC_API_KEY"],
          key: "provider-key",
        },
      ]),
      resolveOptions({ apiKey: "override-key" }),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.apiKey).toBe("override-key")
    expect(resolved.mode).toBe("apiKey")
  })

  test("env provider keys are used when present", async () => {
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "env",
          env: ["ANTHROPIC_API_KEY"],
          key: "env-key",
        },
      ]),
      resolveOptions({}),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.apiKey).toBe("env-key")
  })

  test("dummy and empty keys are treated as no key and fall through", async () => {
    const sentinelResolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "api",
          env: ["ANTHROPIC_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({}),
    )
    expect((await sentinelResolver.resolve("anthropic/claude-haiku-4-5")).mode).toBe("default")

    __resetAuthCachesForTest()
    const emptyResolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "api",
          env: ["ANTHROPIC_API_KEY"],
          key: "",
        },
      ]),
      resolveOptions({}),
    )
    expect((await emptyResolver.resolve("anthropic/claude-haiku-4-5")).mode).toBe("default")
  })

  test("multi-var providers fall back to their own env discovery", async () => {
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "amazon-bedrock",
          source: "env",
          env: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        },
      ]),
      resolveOptions({ translatorModel: "amazon-bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0" }),
    )

    const resolved = await resolver.resolve("amazon-bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0")
    expect(resolved.mode).toBe("default")
    expect(resolved.apiKey).toBeUndefined()
  })

  test("OPENCODE_AUTH_CONTENT enables OAuth reuse without touching the filesystem", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      },
    })

    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "custom",
          env: ["ANTHROPIC_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({}),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("oauth")
    expect(resolved.apiKey).toBe("")
    expect(typeof resolved.fetch).toBe("function")
  })

  test("expired OAuth tokens refresh once and persist updated auth", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1000,
      },
    })
    const authSetCalls: unknown[] = []
    let fetchCalls = 0
    const resolver = createCredentialResolver(
      fakeClient(
        [
          {
            id: "anthropic",
            source: "custom",
            env: ["ANTHROPIC_API_KEY"],
            key: "opencode-oauth-dummy-key",
          },
        ],
        authSetCalls,
      ),
      resolveOptions({}),
      {
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(
            JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        },
        sleep: async () => undefined,
      },
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("oauth")
    expect(fetchCalls).toBe(1)
    expect(authSetCalls).toHaveLength(1)
    expect(authSetCalls[0]).toEqual({
      path: { id: "anthropic" },
      body: {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: expect.any(Number),
        accountId: undefined,
        enterpriseUrl: undefined,
      },
    })
  })

  test("expired OpenAI OAuth tokens refresh with Codex form body", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1000,
        accountId: "acct_1",
      },
    })
    const authSetCalls: unknown[] = []
    let refreshBody = ""
    const resolver = createCredentialResolver(
      fakeClient(
        [
          {
            id: "openai",
            source: "custom",
            env: ["OPENAI_API_KEY"],
            key: "opencode-oauth-dummy-key",
          },
        ],
        authSetCalls,
      ),
      resolveOptions({ translatorModel: "openai/gpt-5.5" }),
      {
        fetchImpl: async (_input, init) => {
          refreshBody = String(init?.body)
          return new Response(
            JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        },
        sleep: async () => undefined,
      },
    )

    const resolved = await resolver.resolve("openai/gpt-5.5")

    expect(resolved.mode).toBe("oauth")
    expect(refreshBody).toBe(
      "grant_type=refresh_token&refresh_token=old-refresh&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
    )
    expect(authSetCalls[0]).toEqual({
      path: { id: "openai" },
      body: {
        type: "oauth",
        access: "new-access",
        refresh: "new-refresh",
        expires: expect.any(Number),
        accountId: "acct_1",
        enterpriseUrl: undefined,
      },
    })
  })

  test("OAuth refresh is coalesced across concurrent resolves", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1000,
      },
    })
    let fetchCalls = 0
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "custom",
          env: ["ANTHROPIC_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({}),
      {
        fetchImpl: async () => {
          fetchCalls += 1
          await Promise.resolve()
          return new Response(
            JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        },
        sleep: async () => undefined,
      },
    )

    await Promise.all([resolver.resolve("anthropic/claude-haiku-4-5"), resolver.resolve("anthropic/claude-haiku-4-5")])

    expect(fetchCalls).toBe(1)
  })

  test("OAuth refresh failures surface the exact error after retries", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 1000,
      },
    })
    let fetchCalls = 0
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "custom",
          env: ["ANTHROPIC_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({}),
      {
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response("{}", { status: 500 })
        },
        sleep: async () => undefined,
      },
    )

    await expect(resolver.resolve("anthropic/claude-haiku-4-5")).rejects.toThrow(
      '[opencode-translate:OAUTH_REFRESH_FAILED] Failed to refresh OAuth token for provider "anthropic": HTTP 500. Re-authenticate with "opencode auth login anthropic".',
    )
    expect(fetchCalls).toBe(3)
  })

  test("Anthropic OAuth request headers are adapted correctly", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      },
    })
    let finalUrl = ""
    let finalHeaders = new Headers()
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "anthropic",
          source: "custom",
          env: ["ANTHROPIC_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({}),
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
    await resolved.fetch!("https://api.anthropic.com/v1/messages", {
      headers: { "x-api-key": "dummy" },
    })

    expect(finalUrl).toContain("?beta=true")
    expect(finalHeaders.get("Authorization")).toBe("Bearer access-token")
    expect(finalHeaders.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(finalHeaders.get("anthropic-version")).toBe("2023-06-01")
    expect(finalHeaders.get("x-api-key")).toBeNull()
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
      fakeClient([
        {
          id: "openai",
          source: "custom",
          env: ["OPENAI_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({ translatorModel: "openai/gpt-5.5" }),
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
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      },
    })
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "openai",
          source: "custom",
          env: ["OPENAI_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({ translatorModel: "openai/gpt-5.5" }),
      {
        fetchImpl: async () =>
          new Response(
            `event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: { id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
            })}\n\n`,
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
    expect(await response.json()).toEqual({ id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 1 } })
  })

  test("OpenAI OAuth rewrites Chat Completions messages to Codex request shape", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      },
    })
    let finalBody = ""
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "openai",
          source: "custom",
          env: ["OPENAI_API_KEY"],
          key: "opencode-oauth-dummy-key",
        },
      ]),
      resolveOptions({ translatorModel: "openai/gpt-5.5" }),
      {
        fetchImpl: async (_input, init) => {
          finalBody = String(init?.body)
          return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
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

  test("provider-list failures fall through to default resolution instead of throwing", async () => {
    const resolver = createCredentialResolver(
      {
        ...fakeClient([]),
        provider: {
          list: async () => {
            throw new Error("unavailable")
          },
        },
      },
      resolveOptions({}),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("default")
  })
})
