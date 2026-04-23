import { beforeEach, describe, expect, test } from "bun:test"
import type { PluginClientLike } from "../src/constants"
import { protectText, restoreProtectedText } from "../src/protect"
import { __resetTranslatorCachesForTest, createTranslator } from "../src/translator"

function fakeClient(): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID: null }),
      messages: async () => [],
      message: async () => ({ info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [] }),
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

describe("protect", () => {
  beforeEach(() => {
    __resetTranslatorCachesForTest()
  })

  test("protected spans round-trip through placeholder restoration", () => {
    const input = [
      "```sh",
      "npm run build -- --watch",
      "```",
      "Use `bun test` and open https://example.com/docs.",
      "Paths: /usr/local/bin, C:\\Users\\dev\\file.ts, src/index.ts, $OPENAI_API_KEY.",
      "    at run (/tmp/app.ts:10:2)",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      '"name": "value"',
      '<div data-kind="demo">',
      "Ping @octocat and see #42 at deadbeef and camelCase snake_case kebab-case SCREAMING_SNAKE_CASE.",
    ].join("\n")

    const plan = protectText(input)
    const restored = restoreProtectedText(plan, plan.text)

    expect(plan.placeholders.length).toBeGreaterThan(5)
    expect(restored.ok).toBe(true)
    if (restored.ok) {
      expect(restored.text).toBe(input)
    }
  })

  test("dropping a placeholder triggers the stricter retry path", async () => {
    const input = "`bun test` 결과를 /tmp/out.txt 에 저장해줘"
    const plan = protectText(input)
    let calls = 0
    let secondSystem = ""

    const translator = createTranslator(
      fakeClient(),
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
        generateTextImpl: async ({ system }) => {
          calls += 1
          if (calls === 1) {
            return { text: plan.text.replace(plan.placeholders[0].token, "") } as never
          }
          secondSystem = String(system)
          return { text: plan.text } as never
        },
        sleep: async () => undefined,
      },
    )

    const translated = await translator.translateText({
      text: input,
      sourceLanguage: "ko",
      targetLanguage: "en",
      direction: "inbound",
    })

    expect(calls).toBe(2)
    expect(secondSystem).toContain("Additional correction")
    expect(translated).toBe(input)
  })

  test("hallucinated placeholders are detected by the post-check", () => {
    const plan = protectText("`bun test`")
    const restored = restoreProtectedText(plan, `${plan.text} ⟦OCTX:inline-code:999⟧`)

    expect(restored.ok).toBe(false)
    if (!restored.ok) {
      expect(restored.extra).toEqual(["⟦OCTX:inline-code:999⟧"])
    }
  })
})
