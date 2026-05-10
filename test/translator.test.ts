import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../src/activation"
import { __resetAuthCachesForTest, createCredentialResolver } from "../src/auth"
import { type MessageWithPartsLike, type PluginClientLike, resolveOptions, type TextPartLike } from "../src/constants"
import {
  __resetSyntheticPartIDForTest,
  __resetTranslatorCachesForTest,
  createSyntheticPartID,
  createTranslator,
  hashText,
} from "../src/translator"

function textPart(id: string, text: string, extra: Partial<TextPartLike> = {}): TextPartLike {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text,
    ...extra,
  }
}

function activeStateMetadata(text: string) {
  return {
    translate_enabled: true,
    translate_source_lang: "ko",
    translate_display_lang: "ko",
    translate_llm_lang: "en",
    translate_nonce: "0123456789abcdef0123456789abcdef",
    translate_source_hash: hashText(text),
    translate_en: `EN:${text}`,
  }
}

function fakeClient(messages: MessageWithPartsLike[]): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID: null }),
      messages: async () => messages,
      message: async () => messages[0],
    },
    provider: {
      list: async () => ({ all: [] }),
    },
    auth: {
      set: async () => undefined,
    },
    app: {
      log: async () => undefined,
    },
  }
}

function encodeAscendingPartIDForTest(timestamp: number, counter: number): string {
  const encoded = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter)
  const bytes = Buffer.alloc(6)
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & BigInt(0xff))
  }
  return `prt_${bytes.toString("hex")}00000000000000`
}

describe("translator", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
    __resetAuthCachesForTest()
    __resetTranslatorCachesForTest()
  })

  test("synthetic part ids use opencode's ascending part-id shape", () => {
    const id = createSyntheticPartID()
    const body = id.slice("prt_".length)

    expect(id.startsWith("prt_")).toBe(true)
    expect(body).toHaveLength(26)
    expect(body.slice(0, 12)).toMatch(/^[0-9a-f]{12}$/)
    expect(body.slice(12)).toMatch(/^[0-9A-Za-z]{14}$/)
  })

  test("synthetic part ids are lexicographically ascending within one millisecond", () => {
    const realDateNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      __resetSyntheticPartIDForTest()
      const ids = Array.from({ length: 32 }, () => createSyntheticPartID())

      expect(ids).toEqual([...ids].sort())
    } finally {
      Date.now = realDateNow
    }
  })

  test("synthetic part ids sort after prior timestamp-based user part ids", () => {
    const realDateNow = Date.now
    const userTimestamp = 1_700_000_000_000
    const userPartID = encodeAscendingPartIDForTest(userTimestamp, 1)
    Date.now = () => userTimestamp + 1
    try {
      __resetSyntheticPartIDForTest()
      const syntheticPartID = createSyntheticPartID()

      expect(syntheticPartID > userPartID).toBe(true)
    } finally {
      Date.now = realDateNow
    }
  })

  test("retry succeeds after one transient failure", async () => {
    let calls = 0
    const translator = createTranslator(
      fakeClient([]),
      {
        translatorModel: "anthropic/claude-haiku-4-5",
        triggerKeywords: ["$en"],
        sourceLanguage: "ko",
        displayLanguage: "ko",
        verbose: false,
      },
      {
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
      },
    )

    const translated = await translator.translateText({
      text: "안녕",
      sourceLanguage: "ko",
      targetLanguage: "en",
      direction: "inbound",
    })

    expect(translated).toBe("hello")
    expect(calls).toBe(2)
  })

  test("OpenAI reasoning translators omit unsupported temperature", async () => {
    let request: Record<string, unknown> | undefined
    const translator = createTranslator(
      fakeClient([]),
      {
        translatorModel: "openai/gpt-5.5",
        triggerKeywords: ["$en"],
        sourceLanguage: "ko",
        displayLanguage: "ko",
        verbose: false,
      },
      {
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
      },
    )

    await translator.translateText({
      text: "안녕",
      sourceLanguage: "ko",
      targetLanguage: "en",
      direction: "inbound",
    })

    expect(request?.temperature).toBeUndefined()
  })

  test("final failure in chat.message does not throw and falls back to the untranslated text", async () => {
    const hooks = createHooks(
      {
        client: fakeClient([]),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async () => {
            throw new Error("translator unavailable")
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "$en 안녕")],
    }

    // Must NOT reject — a thrown error in chat.message stalls OpenCode's
    // session fiber, which appears to the user as infinite loading.
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    // Activation is rolled back so a later turn can retry cleanly. The
    // user's source-language text is preserved (the inline failure
    // warning is appended for visibility), and no translation metadata
    // is persisted.
    expect((output.parts[0] as TextPartLike).text).toContain("안녕")
    expect((output.parts[0] as TextPartLike).text).toContain("Translation failed")
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBeUndefined()
  })

  test("transform leaves user parts untouched on the LLM-only twin architecture", async () => {
    let calls = 0
    const messages = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [
          textPart("hist", "안녕", {
            metadata: activeStateMetadata("안녕"),
          }),
        ],
      },
    ]

    const hooks = createHooks(
      {
        client: fakeClient(messages),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      messages: [
        {
          info: { id: "msg_user", sessionID: "ses_1", role: "user" },
          parts: [
            textPart("hist", "안녕", {
              metadata: activeStateMetadata("안녕"),
            }),
          ],
        },
      ],
    }

    await hooks["experimental.chat.messages.transform"]!({} as never, output as never)

    // The translator must never run inside transform (no network in this
    // hook), and the user-side source-language text is left untouched.
    // The synthetic LLM-only English twin (added in `chat.message`) is
    // what actually feeds the model; transform is responsible only for
    // assistant-side trailer stripping now.
    expect(calls).toBe(0)
    expect((output.messages[0].parts[0] as TextPartLike).text).toBe("안녕")
  })

  test("hash mismatch in transform does not throw and does not call the translator", async () => {
    let calls = 0
    const history = [
      {
        info: { id: "msg_user", sessionID: "ses_1", role: "user" },
        parts: [
          textPart("hist", "원본", {
            metadata: activeStateMetadata("원본"),
          }),
        ],
      },
    ]

    const hooks = createHooks(
      {
        client: fakeClient(history),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      messages: [
        {
          info: { id: "msg_user", sessionID: "ses_1", role: "user" },
          parts: [
            textPart("hist", "편집됨", {
              metadata: activeStateMetadata("원본"),
            }),
          ],
        },
      ],
    }

    // Must NOT reject — throwing from a hook stalls OpenCode's session.
    // The edited text stays as-is so the original user message still
    // reaches the model.
    await hooks["experimental.chat.messages.transform"]!({} as never, output as never)

    expect(calls).toBe(0)
    expect((output.messages[0].parts[0] as TextPartLike).text).toBe("편집됨")
  })

  test("synthetic user parts are skipped during inbound translation", async () => {
    let calls = 0
    const hooks = createHooks(
      {
        client: fakeClient([]),
        directory: "/workspace",
      } as never,
      { sourceLanguage: "ko", displayLanguage: "ko" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [
        textPart("p1", "$en 첫번째"),
        textPart("p2", "compaction marker", {
          synthetic: true,
          ignored: true,
          metadata: { compaction_continue: true },
        }),
        textPart("p3", "두번째"),
      ],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    // After two user-authored translations the layout is:
    //   [0] "첫번째\n\n_→ EN: EN:첫번째_"  (source augmented w/ inline preview, ignored:true)
    //   [1] "EN:첫번째"                   (LLM-only synthetic twin)
    //   [2] compaction marker             (untouched, was synthetic in input)
    //   [3] "두번째\n\n_→ EN: EN:두번째_"  (source augmented w/ inline preview, ignored:true)
    //   [4] "EN:두번째"                   (LLM-only synthetic twin)
    //   [5] activation banner
    expect(calls).toBe(2)
    expect((output.parts[2] as TextPartLike).text).toBe("compaction marker")
    expect((output.parts[2] as TextPartLike).synthetic).toBe(true)
  })

  test("missing credentials surface the exact auth-unavailable error", async () => {
    const translator = createTranslator(
      fakeClient([]),
      {
        translatorModel: "anthropic/claude-haiku-4-5",
        triggerKeywords: ["$en"],
        sourceLanguage: "ko",
        displayLanguage: "ko",
        verbose: false,
      },
      {
        credentialResolver: {
          resolve: async () => ({
            providerID: "anthropic",
            provider: {
              id: "anthropic",
              source: "env",
              env: ["ANTHROPIC_API_KEY"],
            },
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
      },
    )

    await expect(
      translator.translateText({
        text: "안녕",
        sourceLanguage: "ko",
        targetLanguage: "en",
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
          all: [
            {
              id: "openai",
              source: "custom" as const,
              env: ["OPENAI_API_KEY"],
              key: "opencode-oauth-dummy-key",
            },
          ],
        }),
      },
    }
    const options = resolveOptions({ translatorModel: "openai/gpt-5.5", sourceLanguage: "ko", displayLanguage: "ko" })
    let finalUrl = ""
    let finalBody = ""
    const credentialResolver = createCredentialResolver(client, options, {
      fetchImpl: async (input, init) => {
        finalUrl = input instanceof URL ? input.href : String(input)
        finalBody = String(init?.body)
        const response = {
          id: "resp_1",
          created_at: 1_700_000_000,
          model: "gpt-5.5",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "hello", annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        }
        return new Response(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        )
      },
      sleep: async () => undefined,
    })
    const translator = createTranslator(client, options, { credentialResolver, sleep: async () => undefined })

    try {
      const translated = await translator.translateText({
        text: "안녕",
        sourceLanguage: "ko",
        targetLanguage: "en",
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
})
