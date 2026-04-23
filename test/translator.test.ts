import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../src/activation"
import type { MessageWithPartsLike, PluginClientLike, TextPartLike } from "../src/constants"
import { __resetTranslatorCachesForTest, createTranslator, hashText } from "../src/translator"

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

describe("translator", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
    __resetTranslatorCachesForTest()
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

    // Activation is rolled back so a later turn can retry cleanly.
    // Only the original (trigger-stripped) user part remains.
    expect((output.parts[0] as TextPartLike).text).toBe("안녕")
    expect((output.parts[0] as TextPartLike).metadata?.translate_en).toBeUndefined()
  })

  test("valid cached history rewrites user text without calling the translator", async () => {
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

    expect(calls).toBe(0)
    expect((output.messages[0].parts[0] as TextPartLike).text).toBe("EN:안녕")
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

    expect(calls).toBe(2)
    expect((output.parts[2] as TextPartLike).text).toBe("compaction marker")
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
})
