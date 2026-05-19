import { beforeEach, expect, test } from "bun:test"
import { __resetAuthCachesForTest, createCredentialResolver } from "../../src/auth"
import { resolveOptions } from "../../src/constants"
import { __resetTranslatorCachesForTest, createTranslator } from "../../src/translator"
import { fakeClient } from "./helpers"

function testOptions(overrides: Record<string, unknown> = {}) {
  return {
    translatorModel: "anthropic/claude-haiku-4-5",
    triggerKeywords: ["$en"],
    lang: "Korean",
    verbose: false,
    ...overrides,
  }
}

beforeEach(() => {
  __resetAuthCachesForTest()
  __resetTranslatorCachesForTest()
})

test("retry succeeds after one transient failure", async () => {
  let calls = 0
  const translator = createTranslator(fakeClient([]), testOptions(), {
    credentialResolver: {
      resolve: async () => ({ providerID: "anthropic", apiKey: "test-key", mode: "apiKey" as const }),
      isMissingCredentialError: () => false,
      authUnavailable: () => new Error("unused"),
      envFallback: "ANTHROPIC_API_KEY",
    },
    generateTextImpl: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error("HTTP 500") as Error & { status?: number }
        error.status = 500
        throw error
      }
      return { text: "hello" } as never
    },
    sleep: async () => undefined,
    now: (() => {
      let value = 0
      return () => (value += 10)
    })(),
  })

  const translated = await translator.translateText({
    text: "안녕",
    sourceLanguage: "Korean",
    targetLanguage: "English",
    direction: "inbound",
  })
  expect(translated).toBe("hello")
  expect(calls).toBe(2)
})

test("retry can use the default zero-delay sleeper", async () => {
  let calls = 0
  const translator = createTranslator(fakeClient([]), testOptions(), {
    credentialResolver: {
      resolve: async () => ({ providerID: "anthropic", apiKey: "test-key", mode: "apiKey" as const }),
      isMissingCredentialError: () => false,
      authUnavailable: () => new Error("unused"),
      envFallback: "ANTHROPIC_API_KEY",
    },
    generateTextImpl: async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error("rate limited") as Error & { status?: number; response?: Response }
        error.status = 429
        error.response = new Response("", { status: 429, headers: { "retry-after": "0" } })
        throw error
      }
      return { text: "hello" } as never
    },
  })

  await expect(
    translator.translateText({
      text: "안녕",
      sourceLanguage: "Korean",
      targetLanguage: "English",
      direction: "inbound",
    }),
  ).resolves.toBe("hello")
  expect(calls).toBe(2)
})

test("unwraps echoed text envelope from translator output", async () => {
  const translator = createTranslator(fakeClient([]), testOptions({ lang: "English" }), {
    credentialResolver: {
      resolve: async () => ({ providerID: "anthropic", apiKey: "test-key", mode: "apiKey" as const }),
      isMissingCredentialError: () => false,
      authUnavailable: () => new Error("unused"),
      envFallback: "ANTHROPIC_API_KEY",
    },
    generateTextImpl: async () => ({ text: "<text>\n안녕하세요\n</text>" }) as never,
    sleep: async () => undefined,
  })

  const translated = await translator.translateText({
    text: "Hello",
    sourceLanguage: "English",
    targetLanguage: "Korean",
    direction: "outbound",
  })
  expect(translated).toBe("안녕하세요")
})

test("OpenAI reasoning translators omit unsupported temperature", async () => {
  let request: Record<string, unknown> | undefined
  const translator = createTranslator(fakeClient([]), testOptions({ translatorModel: "openai/gpt-5.5" }), {
    credentialResolver: {
      resolve: async () => ({ providerID: "openai", apiKey: "test-key", mode: "apiKey" as const }),
      isMissingCredentialError: () => false,
      authUnavailable: () => new Error("unused"),
      envFallback: "OPENAI_API_KEY",
    },
    generateTextImpl: async (input) => {
      request = input as Record<string, unknown>
      return { text: "hello" } as never
    },
    sleep: async () => undefined,
  })

  await translator.translateText({
    text: "안녕",
    sourceLanguage: "Korean",
    targetLanguage: "English",
    direction: "inbound",
  })
  expect(request?.temperature).toBeUndefined()
})

test("missing credentials surface the exact auth-unavailable error", async () => {
  const translator = createTranslator(fakeClient([]), testOptions(), {
    credentialResolver: {
      resolve: async () => ({
        providerID: "anthropic",
        provider: { id: "anthropic", source: "env", env: ["ANTHROPIC_API_KEY"] },
        mode: "default" as const,
      }),
      isMissingCredentialError: () => true,
      authUnavailable: () => new Error("unused"),
      envFallback: "ANTHROPIC_API_KEY",
    },
    generateTextImpl: async () => {
      throw new Error("Missing API key")
    },
    sleep: async () => undefined,
  })

  await expect(
    translator.translateText({
      text: "안녕",
      sourceLanguage: "Korean",
      targetLanguage: "English",
      direction: "inbound",
    }),
  ).rejects.toThrow(
    '[opencode-translate:AUTH_UNAVAILABLE] No credential found for provider "anthropic". Set ANTHROPIC_API_KEY in the environment, run "opencode auth login anthropic", or set options.apiKey in opencode.json.',
  )
})

test("OpenAI OAuth translator requests are Codex-compatible", async () => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    openai: {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3600_000,
      accountId: "acct_1",
    },
  })
  const client = {
    ...fakeClient([]),
    provider: {
      list: async () => ({
        all: [{ id: "openai", source: "custom" as const, env: ["OPENAI_API_KEY"], key: "opencode-oauth-dummy-key" }],
      }),
    },
  }
  const options = resolveOptions({ translatorModel: "openai/gpt-5.5", lang: "Korean" })
  let finalUrl = ""
  let finalBody = ""
  const credentialResolver = createCredentialResolver(client, options, {
    fetchImpl: async (input, init) => {
      finalUrl = input instanceof URL ? input.href : String(input)
      finalBody = String(init?.body)
      return new Response(
        [
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.5", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )
    },
    sleep: async () => undefined,
  })
  const translator = createTranslator(client, options, { credentialResolver, sleep: async () => undefined })

  try {
    const translated = await translator.translateText({
      text: "안녕",
      sourceLanguage: "Korean",
      targetLanguage: "English",
      direction: "inbound",
    })
    const parsed = JSON.parse(finalBody) as Record<string, unknown>
    expect(translated).toBe("hello")
    expect(finalUrl).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(parsed.instructions).toContain("professional translator")
    expect(parsed.stream).toBe(true)
    expect(parsed.include).toEqual(["reasoning.encrypted_content"])
    expect(parsed.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "<text>\n안녕\n</text>" }] },
    ])
  } finally {
    delete process.env.OPENCODE_AUTH_CONTENT
  }
})

test("verbose translation logs timing and character metadata", async () => {
  const logs: unknown[] = []
  const client = {
    ...fakeClient([]),
    app: {
      log: async (input: unknown) => {
        logs.push(input)
        return undefined
      },
    },
  }
  const translator = createTranslator(client, testOptions({ verbose: true }), {
    credentialResolver: {
      resolve: async () => ({ providerID: "anthropic", apiKey: "test-key", mode: "apiKey" as const }),
      isMissingCredentialError: () => false,
      authUnavailable: () => new Error("unused"),
      envFallback: "ANTHROPIC_API_KEY",
    },
    generateTextImpl: async () => ({ text: "hello" }) as never,
    sleep: async () => undefined,
    now: (() => {
      const values = [100, 145]
      return () => values.shift() ?? 145
    })(),
  })

  await expect(
    translator.translateText({
      text: "안녕",
      sourceLanguage: "Korean",
      targetLanguage: "English",
      direction: "inbound",
    }),
  ).resolves.toBe("hello")
  expect(logs).toEqual([
    {
      body: {
        service: "opencode-translate",
        level: "info",
        message: "translated",
        extra: {
          direction: "inbound",
          chars_in: 2,
          chars_out: 5,
          ms: 45,
          cached: false,
          model: "anthropic/claude-haiku-4-5",
        },
      },
    },
  ])
})

test("translator requests are bounded by the configured timeout", async () => {
  const translator = createTranslator(fakeClient([]), testOptions(), {
    credentialResolver: {
      resolve: async () => ({ providerID: "anthropic", apiKey: "test-key", mode: "apiKey" as const }),
      isMissingCredentialError: () => false,
      authUnavailable: () => new Error("unused"),
      envFallback: "ANTHROPIC_API_KEY",
    },
    generateTextImpl: async () => new Promise(() => undefined) as never,
    sleep: async () => undefined,
    timeoutMs: 1,
  })

  await expect(
    translator.translateText({
      text: "안녕",
      sourceLanguage: "Korean",
      targetLanguage: "English",
      direction: "inbound",
    }),
  ).rejects.toThrow("Translator generateText timed out after 1ms")
})
