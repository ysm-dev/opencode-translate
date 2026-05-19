import { afterEach, describe, expect, test } from "bun:test"
import { withRetry as withAuthRetry } from "../../src/auth/retry"
import { ensureOAuthInfo, normalizeProviderKey, readAuthMap } from "../../src/auth/store"
import { withRetry as withTranslatorRetry } from "../../src/translator/retry"

describe("auth and translator retry helpers", () => {
  test("auth retry honors retry-after seconds for one 429 retry", async () => {
    const sleeps: number[] = []
    let calls = 0

    const result = await withAuthRetry(
      async () => {
        calls += 1
        if (calls === 1) {
          const error = new Error("rate limited") as Error & { response?: Response }
          error.response = new Response("", { status: 429, headers: { "retry-after": "0.25" } })
          throw error
        }
        return "ok"
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    )

    expect(result).toBe("ok")
    expect(calls).toBe(2)
    expect(sleeps).toEqual([250])
  })

  test("auth retry stops after the second 429", async () => {
    const sleeps: number[] = []
    const error = new Error("rate limited") as Error & { status?: number; response?: Response }
    error.status = 429
    error.response = new Response("", { status: 429, headers: { "retry-after": "0" } })

    await expect(
      withAuthRetry(
        async () => {
          throw error
        },
        { sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toThrow("rate limited")
    expect(sleeps).toEqual([0])
  })

  test("auth retry uses backoff for statusCode server errors", async () => {
    const sleeps: number[] = []
    let calls = 0

    const result = await withAuthRetry(
      async () => {
        calls += 1
        if (calls < 3) {
          const error = new Error("server failed") as Error & { statusCode?: number }
          error.statusCode = 503
          throw error
        }
        return "recovered"
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    )

    expect(result).toBe("recovered")
    expect(sleeps).toEqual([500, 1500])
  })

  test("auth retry does not retry non-retryable client errors", async () => {
    let calls = 0
    const error = new Error("bad request") as Error & { response?: { status: number } }
    error.response = { status: 400 }

    await expect(
      withAuthRetry(
        async () => {
          calls += 1
          throw error
        },
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("bad request")
    expect(calls).toBe(1)
  })

  test("auth retry falls back to message matching and default retry-after delay", async () => {
    const sleeps: number[] = []
    let calls = 0

    const messageMatched = await withAuthRetry(
      async () => {
        calls += 1
        if (calls === 1) {
          const error = new Error("fetch failed") as Error & { response?: { status: string } }
          error.response = { status: "not-a-number" }
          throw error
        }
        return "ok"
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    )
    expect(messageMatched).toBe("ok")

    let rateLimitCalls = 0
    const rateLimited = await withAuthRetry(
      async () => {
        rateLimitCalls += 1
        if (rateLimitCalls === 1) {
          const error = new Error("rate limited") as Error & { status?: number; response?: Response }
          error.status = 429
          error.response = new Response("", { status: 429, headers: { "retry-after": "not-a-date" } })
          throw error
        }
        return "retried"
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    )

    expect(rateLimited).toBe("retried")
    expect(sleeps).toEqual([500, 2000])
  })

  test("translator retry honors retry-after dates and network errors", async () => {
    const sleeps: number[] = []
    let calls = 0

    const result = await withTranslatorRetry(
      async () => {
        calls += 1
        if (calls === 1) {
          const error = new Error("rate limited") as Error & { response?: Response }
          error.response = new Response("", {
            status: 429,
            headers: { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" },
          })
          throw error
        }
        if (calls === 2) throw new Error("network socket closed")
        return "translated"
      },
      async (ms) => void sleeps.push(ms),
    )

    expect(result).toBe("translated")
    expect(sleeps).toEqual([0, 1500])
  })

  test("translator retry rethrows after repeated transient failures", async () => {
    const sleeps: number[] = []

    await expect(
      withTranslatorRetry(
        async () => {
          const error = new Error("timeout") as Error & { status?: number }
          error.status = 504
          throw error
        },
        async (ms) => void sleeps.push(ms),
      ),
    ).rejects.toThrow("timeout")
    expect(sleeps).toEqual([500, 1500])
  })
})

describe("auth store helpers", () => {
  afterEach(() => {
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.XDG_DATA_HOME
    delete process.env.LOCALAPPDATA
  })

  test("normalizeProviderKey and ensureOAuthInfo filter non-OAuth credentials", () => {
    expect(normalizeProviderKey(undefined)).toBeUndefined()
    expect(normalizeProviderKey("opencode-oauth-dummy-key")).toBeUndefined()
    expect(normalizeProviderKey("real-key")).toBe("real-key")
    expect(ensureOAuthInfo({ type: "api", key: "api-key" })).toBeUndefined()
    expect(ensureOAuthInfo({ type: "oauth", access: "a", refresh: "r", expires: 1 })?.access).toBe("a")
  })

  test("readAuthMap returns undefined for invalid OPENCODE_AUTH_CONTENT", async () => {
    process.env.OPENCODE_AUTH_CONTENT = "{not json"
    expect(await readAuthMap({})).toBeUndefined()
  })

  test("readAuthMap reads the OpenCode XDG auth file", async () => {
    delete process.env.OPENCODE_AUTH_CONTENT
    process.env.XDG_DATA_HOME = "/tmp/opencode-translate-test-data"
    let seenPath = ""

    const map = await readAuthMap({
      readFile: async (filePath) => {
        seenPath = filePath
        return JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } })
      },
    })

    expect(seenPath).toBe("/tmp/opencode-translate-test-data/opencode/auth.json")
    expect(map?.anthropic?.type).toBe("oauth")
  })

  test("readAuthMap returns undefined for invalid auth files", async () => {
    delete process.env.OPENCODE_AUTH_CONTENT

    expect(
      await readAuthMap({
        readFile: async () => "{not json",
      }),
    ).toBeUndefined()
  })

  test("readAuthMap normalizes active auth-v2 accounts", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      version: 2,
      active: { anthropic: "acc_1" },
      accounts: {
        acc_1: {
          serviceID: "anthropic",
          credential: { type: "api", key: "api-key", metadata: { resourceName: "resource" } },
        },
      },
    })

    expect(await readAuthMap({})).toEqual({
      anthropic: { type: "api", key: "api-key", metadata: { resourceName: "resource" } },
    })
  })

  test("readAuthMap accepts wellknown credentials and ignores invalid entries", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      github: { type: "wellknown", key: "device-key", token: "device-token" },
      invalidOauth: { type: "oauth", access: "a", refresh: "r" },
      invalidType: { type: "other", key: "ignored" },
    })

    expect(await readAuthMap({})).toEqual({
      github: { type: "wellknown", key: "device-key", token: "device-token" },
    })
  })

  test("readAuthMap follows platform data directories", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")
    const seenPaths: string[] = []
    try {
      process.env.LOCALAPPDATA = "/tmp/opencode-local"
      Object.defineProperty(process, "platform", { value: "win32" })
      await readAuthMap({
        readFile: async (filePath) => {
          seenPaths.push(filePath)
          throw new Error("missing")
        },
      })

      delete process.env.LOCALAPPDATA
      Object.defineProperty(process, "platform", { value: "linux" })
      await readAuthMap({
        readFile: async (filePath) => {
          seenPaths.push(filePath)
          throw new Error("missing")
        },
      })
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform)
    }

    expect(seenPaths[0]).toBe("/tmp/opencode-local/opencode/auth.json")
    expect(seenPaths[2]?.endsWith("/.local/share/opencode/auth.json")).toBe(true)
  })
})
