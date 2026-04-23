import { describe, expect, test } from "bun:test"
import {
  composeTranslatedAssistantText,
  composeTranslationFailureText,
  extractEnglishHistoryText,
} from "../src/formatting"

describe("formatting", () => {
  const nonce = "0123456789abcdef0123456789abcdef"

  test("compose uses the exact success layout", () => {
    const text = composeTranslatedAssistantText("Hello", "한국어 번역", "안녕하세요", nonce)
    expect(text).toBe(
      "Hello\n\n<!-- oc-translate:0123456789abcdef0123456789abcdef:start -->\n---\n\n**한국어 번역:**\n\n안녕하세요\n<!-- oc-translate:0123456789abcdef0123456789abcdef:end -->",
    )
  })

  test("extract returns the exact English half", () => {
    const composed = composeTranslatedAssistantText("Hello", "한국어 번역", "안녕하세요", nonce)
    expect(extractEnglishHistoryText(composed, nonce)).toBe("Hello")
  })

  test("different nonces inside the English half are not truncated", () => {
    const english = "Line 1\n<!-- oc-translate:othernonce:start -->\n---"
    expect(extractEnglishHistoryText(english, nonce)).toBe(english)
  })

  test("plain horizontal rules do not trigger truncation", () => {
    const english = "Title\n\n---\n\nBody"
    expect(extractEnglishHistoryText(english, nonce)).toBe(english)
  })

  test("failure trailers round-trip back to English for history", () => {
    const composed = composeTranslationFailureText("Hello", nonce)
    expect(composed).toContain("_Translation unavailable for this segment._")
    expect(extractEnglishHistoryText(composed, nonce)).toBe("Hello")
  })

  test("malformed or trailing trailers are treated as plain English", () => {
    const malformed = `${composeTranslatedAssistantText("Hello", "한국어 번역", "안녕하세요", nonce)}\nextra`
    expect(extractEnglishHistoryText(malformed, nonce)).toBe(malformed)

    const mismatched = composeTranslatedAssistantText(
      "Hello",
      "한국어 번역",
      "안녕하세요",
      "ffffffffffffffffffffffffffffffff",
    )
    expect(extractEnglishHistoryText(mismatched, nonce)).toBe(mismatched)
  })

  test("compose extract compose is stable", () => {
    const composed = composeTranslatedAssistantText("Hello", "한국어 번역", "안녕하세요", nonce)
    const extracted = extractEnglishHistoryText(composed, nonce)
    expect(composeTranslatedAssistantText(extracted, "한국어 번역", "안녕하세요", nonce)).toBe(composed)
  })
})
