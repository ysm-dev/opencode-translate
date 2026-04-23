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
