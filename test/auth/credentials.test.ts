import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetAuthCachesForTest, createCredentialResolver } from "../../src/auth"
import { fakeClient } from "./helpers"

describe("auth credentials", () => {
  beforeEach(() => {
    __resetAuthCachesForTest()
    process.env.OPENCODE_AUTH_CONTENT = "{}"
  })

  afterEach(() => {
    delete process.env.OPENCODE_AUTH_CONTENT
  })

  test("credential caches are isolated per resolver", async () => {
    const first = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "first-key" }]),
    )
    const second = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "second-key" }]),
    )

    expect((await first.resolve("anthropic/claude-haiku-4-5")).apiKey).toBe("first-key")
    expect((await second.resolve("anthropic/claude-haiku-4-5")).apiKey).toBe("second-key")
  })

  test("env provider keys are used when present", async () => {
    const resolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "env", env: ["ANTHROPIC_API_KEY"], key: "env-key" }]),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.apiKey).toBe("env-key")
  })

  test("dummy and empty keys are treated as no key and fall through", async () => {
    const sentinelResolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    )
    expect((await sentinelResolver.resolve("anthropic/claude-haiku-4-5")).mode).toBe("default")

    __resetAuthCachesForTest()
    const emptyResolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "" }]),
    )
    expect((await emptyResolver.resolve("anthropic/claude-haiku-4-5")).mode).toBe("default")
  })

  test("multi-var providers fall back to their own env discovery", async () => {
    const model = "amazon-bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0"
    const resolver = createCredentialResolver(
      fakeClient([
        {
          id: "amazon-bedrock",
          source: "env",
          env: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
        },
      ]),
    )

    const resolved = await resolver.resolve(model)
    expect(resolved.mode).toBe("default")
    expect(resolved.apiKey).toBeUndefined()
  })

  test("OPENCODE_AUTH_CONTENT enables OAuth reuse without touching the filesystem", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
    })

    const resolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "custom", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("oauth")
    expect(resolved.apiKey).toBe("")
    expect(typeof resolved.fetch).toBe("function")
  })

  test("OpenAI OAuth auth wins over resolved API keys", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
    })

    const resolver = createCredentialResolver(
      fakeClient([{ id: "openai", source: "env", env: ["OPENAI_API_KEY"], key: "provider-key" }]),
    )

    const resolved = await resolver.resolve("openai/gpt-5.5")
    expect(resolved.mode).toBe("oauth")
    expect(resolved.apiKey).toBe("")
    expect(typeof resolved.fetch).toBe("function")
  })

  test("OpenAI OAuth auth can replace a cached API-key credential", async () => {
    const resolver = createCredentialResolver(
      fakeClient([{ id: "openai", source: "env", env: ["OPENAI_API_KEY"], key: "provider-key" }]),
    )

    expect((await resolver.resolve("openai/gpt-5.5")).apiKey).toBe("provider-key")

    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      openai: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600_000 },
    })

    const resolved = await resolver.resolve("openai/gpt-5.5")
    expect(resolved.mode).toBe("oauth")
    expect(resolved.apiKey).toBe("")
    expect(typeof resolved.fetch).toBe("function")
  })

  test("OpenAI falls back to resolved provider key if the OAuth record disappears before fetch setup", async () => {
    delete process.env.OPENCODE_AUTH_CONTENT
    let reads = 0
    const resolver = createCredentialResolver(
      fakeClient([{ id: "openai", source: "env", env: ["OPENAI_API_KEY"], key: "provider-key" }]),
      {
        readFile: async () => {
          reads += 1
          if (reads === 1) {
            return JSON.stringify({
              openai: {
                type: "oauth",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 3600_000,
              },
            })
          }
          return "{}"
        },
      },
    )

    const resolved = await resolver.resolve("openai/gpt-5.5")
    expect(resolved.mode).toBe("apiKey")
    expect(resolved.apiKey).toBe("provider-key")
  })

  test("auth file API records are used when provider keys are absent", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: { type: "api", key: "stored-key" },
    })

    const resolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"] }]),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("apiKey")
    expect(resolved.apiKey).toBe("stored-key")
  })

  test("OAuth records without request adapters can be used as bearer keys", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      "custom-provider": {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      },
    })

    const resolver = createCredentialResolver(
      fakeClient([{ id: "custom-provider", source: "env", env: ["CUSTOM_PROVIDER_API_KEY"] }]),
    )

    const resolved = await resolver.resolve("custom-provider/model")
    expect(resolved.mode).toBe("oauth")
    expect(resolved.apiKey).toBe("access-token")
    expect(resolved.fetch).toBeUndefined()
  })

  test("provider-list failures fall through to default resolution instead of throwing", async () => {
    const resolver = createCredentialResolver({
      ...fakeClient([]),
      provider: {
        list: async () => {
          throw new Error("unavailable")
        },
      },
    })

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("default")
  })

  test("missing credential detection covers common provider error wording", () => {
    const resolver = createCredentialResolver(fakeClient([]))

    expect(resolver.isMissingCredentialError(new Error("API key missing"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("api-key required"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("missing credentials"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("missing authentication"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("missing auth token"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("no auth configured"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("permission denied"))).toBe(false)
  })

  test("authUnavailable falls back to the generic API-key hint", () => {
    const resolver = createCredentialResolver(fakeClient([]))

    expect(resolver.authUnavailable("custom-provider").message).toContain("Set the provider's API key env var")
  })
})
