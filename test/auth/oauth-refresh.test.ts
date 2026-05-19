import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetAuthCachesForTest, createCredentialResolver } from "../../src/auth"
import { exchangeCopilotToken, refreshAnthropic, refreshOpenAI } from "../../src/auth/refresh"
import { resolveOptions } from "../../src/constants"
import { fakeClient } from "./helpers"

beforeEach(() => {
  __resetAuthCachesForTest()
  process.env.OPENCODE_AUTH_CONTENT = "{}"
})

afterEach(() => {
  delete process.env.OPENCODE_AUTH_CONTENT
})

test("expired OAuth tokens refresh once and persist updated auth", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 },
  })
  const authSetCalls: unknown[] = []
  let fetchCalls = 0
  const resolver = createCredentialResolver(
    fakeClient(
      [{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }],
      authSetCalls,
    ),
    resolveOptions({ lang: "Korean" }),
    {
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
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
      [{ id: "openai", source: "custom", env: ["OPENAI_API_KEY"], key: "opencode-oauth-dummy-key" }],
      authSetCalls,
    ),
    resolveOptions({ translatorModel: "openai/gpt-5.5", lang: "Korean" }),
    {
      fetchImpl: async (_input, init) => {
        refreshBody = String(init?.body)
        return new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      },
      sleep: async () => undefined,
    },
  )

  const resolved = await resolver.resolve("openai/gpt-5.5")
  expect(resolved.mode).toBe("oauth")
  expect(refreshBody).toBe("grant_type=refresh_token&refresh_token=old-refresh&client_id=app_EMoamEEZ73f0CkXaXp7hrann")
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
    anthropic: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 },
  })
  let fetchCalls = 0
  const resolver = createCredentialResolver(
    fakeClient([{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ lang: "Korean" }),
    {
      fetchImpl: async () => {
        fetchCalls += 1
        await Promise.resolve()
        return new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )
      },
      sleep: async () => undefined,
    },
  )

  await Promise.all([resolver.resolve("anthropic/claude-haiku-4-5"), resolver.resolve("anthropic/claude-haiku-4-5")])
  expect(fetchCalls).toBe(1)
})

test("OAuth refresh uses the default zero-delay sleeper when no sleep dependency is supplied", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 },
  })
  let fetchCalls = 0
  const resolver = createCredentialResolver(
    fakeClient([{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ lang: "Korean" }),
    {
      fetchImpl: async () => {
        fetchCalls += 1
        if (fetchCalls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), {
          status: 200,
        })
      },
    },
  )

  await expect(resolver.resolve("anthropic/claude-haiku-4-5")).resolves.toMatchObject({ mode: "oauth" })
  expect(fetchCalls).toBe(2)
})

test("OAuth refresh failures surface the exact error after retries", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 },
  })
  let fetchCalls = 0
  const resolver = createCredentialResolver(
    fakeClient([{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    resolveOptions({ lang: "Korean" }),
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

test("refreshAnthropic wraps invalid JSON and missing token responses", async () => {
  await expect(
    refreshAnthropic(
      { type: "oauth", access: "old", refresh: "refresh", expires: 0 },
      {
        fetchImpl: async () => new Response("not json", { status: 200 }),
        sleep: async () => undefined,
      },
    ),
  ).rejects.toThrow('Failed to refresh OAuth token for provider "anthropic"')

  await expect(
    refreshAnthropic(
      { type: "oauth", access: "old", refresh: "refresh", expires: 0 },
      {
        fetchImpl: async () => new Response(JSON.stringify({ access_token: "new-access" }), { status: 200 }),
        sleep: async () => undefined,
      },
    ),
  ).rejects.toThrow("Invalid token response")
})

test("refreshOpenAI wraps invalid JSON and missing token responses", async () => {
  await expect(
    refreshOpenAI(
      { type: "oauth", access: "old", refresh: "refresh", expires: 0 },
      {
        fetchImpl: async () => new Response("not json", { status: 200 }),
        sleep: async () => undefined,
      },
    ),
  ).rejects.toThrow('Failed to refresh OAuth token for provider "openai"')

  await expect(
    refreshOpenAI(
      { type: "oauth", access: "old", refresh: "refresh", expires: 0 },
      {
        fetchImpl: async () => new Response(JSON.stringify({ refresh_token: "new-refresh" }), { status: 200 }),
        sleep: async () => undefined,
      },
    ),
  ).rejects.toThrow("Invalid token response")
})

test("exchangeCopilotToken rejects malformed token responses", async () => {
  await expect(
    exchangeCopilotToken(
      { type: "oauth", access: "old", refresh: "refresh", expires: 0 },
      {
        fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
        sleep: async () => undefined,
      },
    ),
  ).rejects.toThrow('Failed to refresh OAuth token for provider "github-copilot": Invalid token response')
})
