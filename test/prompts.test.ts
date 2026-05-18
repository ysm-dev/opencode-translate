import { describe, expect, test } from "bun:test"
import { buildSystemPrompt, buildUserPrompt, unwrapEchoedTextEnvelope } from "../src/prompts"

describe("translation prompts", () => {
  test("buildSystemPrompt describes known and unknown language codes", () => {
    expect(buildSystemPrompt({ sourceLanguage: "ko", targetLanguage: "en", text: "안녕" })).toContain(
      "Korean (ko) to English (en)",
    )
    expect(buildSystemPrompt({ sourceLanguage: "tlh", targetLanguage: "de", text: "nuqneH" })).toContain(
      "tlh to German (de)",
    )
  })

  test("buildUserPrompt wraps text in a translation envelope", () => {
    expect(buildUserPrompt({ sourceLanguage: "ko", targetLanguage: "en", text: "안녕" })).toBe("<text>\n안녕\n</text>")
  })

  test("unwrapEchoedTextEnvelope preserves CRLF-delimited inner text", () => {
    expect(unwrapEchoedTextEnvelope("<text>\r\nhello\r\n</text>")).toBe("hello")
    expect(unwrapEchoedTextEnvelope("plain output")).toBe("plain output")
  })
})
