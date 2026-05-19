import { describe, expect, test } from "bun:test"
import { buildSystemPrompt, buildUserPrompt, unwrapEchoedTextEnvelope } from "../src/prompts"

describe("translation prompts", () => {
  test("buildSystemPrompt injects language names directly", () => {
    expect(buildSystemPrompt({ sourceLanguage: "Korean", targetLanguage: "English", text: "안녕" })).toContain(
      "Korean to English",
    )
    expect(buildSystemPrompt({ sourceLanguage: "Klingon", targetLanguage: "German", text: "nuqneH" })).toContain(
      "Klingon to German",
    )
  })

  test("buildUserPrompt wraps text in a translation envelope", () => {
    expect(buildUserPrompt({ sourceLanguage: "Korean", targetLanguage: "English", text: "안녕" })).toBe(
      "<text>\n안녕\n</text>",
    )
  })

  test("unwrapEchoedTextEnvelope preserves CRLF-delimited inner text", () => {
    expect(unwrapEchoedTextEnvelope("<text>\r\nhello\r\n</text>")).toBe("hello")
    expect(unwrapEchoedTextEnvelope("plain output")).toBe("plain output")
  })
})
