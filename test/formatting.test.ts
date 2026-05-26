import { describe, expect, test } from "bun:test"
import {
  composeTranslatedAssistantText,
  composeTranslationFailureText,
  extractEnglishHistoryText,
} from "../src/formatting"

const NONCE = "0123456789abcdef0123456789abcdef"
const LABEL = "Translation (Korean)"

function ctx(overrides: Partial<{ nonce: string; label: string }> = {}) {
  return { nonce: NONCE, label: LABEL, ...overrides }
}

function legacySuccess(english: string, label: string, translated: string, nonce: string) {
  return [
    english,
    "",
    `<!-- oc-translate:${nonce}:start -->`,
    "---",
    "",
    `**${label}:**`,
    "",
    translated,
    `<!-- oc-translate:${nonce}:end -->`,
  ].join("\n")
}

function legacyFailure(english: string, nonce: string) {
  return [
    english,
    "",
    `<!-- oc-translate:${nonce}:start -->`,
    `<!-- oc-translate:${nonce}:status:failed -->`,
    "---",
    "",
    "_Translation unavailable for this segment._",
    "",
    `<!-- oc-translate:${nonce}:end -->`,
  ].join("\n")
}

describe("formatting compose", () => {
  test("success layout is marker-less and renders cleanly in any markdown frontend", () => {
    const text = composeTranslatedAssistantText("Hello", LABEL, "안녕하세요")
    expect(text).toBe("Hello\n\n---\n\n**Translation (Korean):**\n\n안녕하세요")
    expect(text).not.toContain("<!--")
    expect(text).not.toContain("oc-translate")
  })

  test("failure layout is marker-less", () => {
    const text = composeTranslationFailureText("Hello")
    expect(text).toBe("Hello\n\n---\n\n_Translation unavailable for this segment._")
    expect(text).not.toContain("<!--")
    expect(text).not.toContain("oc-translate")
  })
})

describe("formatting structural extract", () => {
  test("returns the exact English half", () => {
    const composed = composeTranslatedAssistantText("Hello", LABEL, "안녕하세요")
    expect(extractEnglishHistoryText(composed, ctx())).toBe("Hello")
  })

  test("preserves multi-line English bodies that contain horizontal rules", () => {
    const english = "Section one\n\n---\n\nSection two"
    const composed = composeTranslatedAssistantText(english, LABEL, "번역")
    expect(extractEnglishHistoryText(composed, ctx())).toBe(english)
  })

  test("plain horizontal rules outside a trailer do not trigger truncation", () => {
    const english = "Title\n\n---\n\nBody"
    expect(extractEnglishHistoryText(english, ctx())).toBe(english)
  })

  test("trailing newlines after the translated half are tolerated", () => {
    const composed = `${composeTranslatedAssistantText("Hello", LABEL, "안녕")}\n\n`
    expect(extractEnglishHistoryText(composed, ctx())).toBe("Hello")
  })

  test("label mismatch leaves text untouched", () => {
    const composed = composeTranslatedAssistantText("Hello", "Translation (Japanese)", "こんにちは")
    expect(extractEnglishHistoryText(composed, ctx())).toBe(composed)
  })

  test("failure trailer round-trips back to English for history", () => {
    const composed = composeTranslationFailureText("Hello")
    expect(extractEnglishHistoryText(composed, ctx())).toBe("Hello")
  })

  test("malformed trailer (missing blank line between separator and label) leaves text untouched", () => {
    const malformed = "Hello\n\n---\n**Translation (Korean):**\n\n안녕"
    expect(extractEnglishHistoryText(malformed, ctx())).toBe(malformed)
  })

  test("malformed trailer (missing separator) leaves text untouched", () => {
    const malformed = "Hello\n\n**Translation (Korean):**\n\n안녕"
    expect(extractEnglishHistoryText(malformed, ctx())).toBe(malformed)
  })

  test("text walked from the end finds the outermost trailer even when translated content mimics the shape", () => {
    const composed = composeTranslatedAssistantText(
      "English with a code sample:\n\n---\n\n**Translation (Korean):**\n\nexample",
      LABEL,
      "한국어 번역",
    )
    expect(extractEnglishHistoryText(composed, ctx())).toBe(
      "English with a code sample:\n\n---\n\n**Translation (Korean):**\n\nexample",
    )
  })

  test("multi-line translations are stripped to the English prefix", () => {
    const composed = composeTranslatedAssistantText("English answer", LABEL, "첫줄\n둘째줄\n셋째줄")
    expect(extractEnglishHistoryText(composed, ctx())).toBe("English answer")
  })

  test("compose -> extract -> compose is stable", () => {
    const composed = composeTranslatedAssistantText("Hello", LABEL, "안녕하세요")
    const extracted = extractEnglishHistoryText(composed, ctx())
    expect(composeTranslatedAssistantText(extracted, LABEL, "안녕하세요")).toBe(composed)
  })
})

describe("formatting legacy marker fallback", () => {
  test("strips success trailers composed with old HTML-comment markers", () => {
    const composed = legacySuccess("Hello", "한국어 번역", "안녕하세요", NONCE)
    expect(extractEnglishHistoryText(composed, ctx())).toBe("Hello")
  })

  test("strips failure trailers composed with old HTML-comment markers", () => {
    const composed = legacyFailure("Hello", NONCE)
    expect(extractEnglishHistoryText(composed, ctx())).toBe("Hello")
  })

  test("legacy parser ignores markers from a different nonce", () => {
    const composed = legacySuccess("Hello", "한국어 번역", "안녕", "ffffffffffffffffffffffffffffffff")
    // No nonce match -> legacy parser fails. Label inside the markers ("한국어 번역")
    // does not match the active session label, so structural parser also fails.
    expect(extractEnglishHistoryText(composed, ctx())).toBe(composed)
  })

  test("legacy parser still recovers when nonce matches even if the label differs", () => {
    const composed = legacySuccess("Hello", "Japanese", "こんにちは", NONCE)
    expect(extractEnglishHistoryText(composed, ctx())).toBe("Hello")
  })
})
