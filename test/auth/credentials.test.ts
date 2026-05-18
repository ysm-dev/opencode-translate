import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetAuthCachesForTest, createCredentialResolver } from "../../src/auth"
import { resolveOptions } from "../../src/constants"
import { fakeClient } from "./helpers"

describe("auth credentials", () => {
  beforeEach(() => {
    __resetAuthCachesForTest()
    process.env.OPENCODE_AUTH_CONTENT = "{}"
  })

  afterEach(() => {
    delete process.env.OPENCODE_AUTH_CONTENT
  })

  test("options.apiKey takes precedence over provider keys", async () => {
    const resolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "provider-key" }]),
      resolveOptions({ apiKey: "override-key" }),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.apiKey).toBe("override-key")
    expect(resolved.mode).toBe("apiKey")
  })

  test("env provider keys are used when present", async () => {
    const resolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "env", env: ["ANTHROPIC_API_KEY"], key: "env-key" }]),
      resolveOptions({}),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.apiKey).toBe("env-key")
  })

  test("dummy and empty keys are treated as no key and fall through", async () => {
    const sentinelResolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "opencode-oauth-dummy-key" }]),
      resolveOptions({}),
    )
    expect((await sentinelResolver.resolve("anthropic/claude-haiku-4-5")).mode).toBe("default")

    __resetAuthCachesForTest()
    const emptyResolver = createCredentialResolver(
      fakeClient([{ id: "anthropic", source: "api", env: ["ANTHROPIC_API_KEY"], key: "" }]),
      resolveOptions({}),
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
      resolveOptions({ translatorModel: model }),
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
      resolveOptions({}),
    )

    const resolved = await resolver.resolve("anthropic/claude-haiku-4-5")
    expect(resolved.mode).toBe("oauth")
    expect(resolved.apiKey).toBe("")
    expect(typeof resolved.fetch).toBe("function")
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

  test("missing credential detection covers common provider error wording", () => {
    const resolver = createCredentialResolver(fakeClient([]), resolveOptions({}))

    expect(resolver.isMissingCredentialError(new Error("API key missing"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("api-key required"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("missing credentials"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("missing authentication"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("missing auth token"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("no auth configured"))).toBe(true)
    expect(resolver.isMissingCredentialError(new Error("permission denied"))).toBe(false)
  })

  test("authUnavailable falls back to the generic API-key hint", () => {
    const resolver = createCredentialResolver(fakeClient([]), resolveOptions({}))

    expect(resolver.authUnavailable("custom-provider").message).toContain("Set the provider's API key env var")
  })
})
