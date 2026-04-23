import { describe, expect, test } from "bun:test"
import { getDisplayLanguageLabel } from "../src/labels"

describe("labels", () => {
  test("exact mapping table values are preserved", () => {
    expect(getDisplayLanguageLabel("en")).toBe("English translation")
    expect(getDisplayLanguageLabel("ko")).toBe("한국어 번역")
    expect(getDisplayLanguageLabel("ja")).toBe("日本語訳")
    expect(getDisplayLanguageLabel("zh")).toBe("中文翻译")
    expect(getDisplayLanguageLabel("zh-CN")).toBe("简体中文翻译")
    expect(getDisplayLanguageLabel("zh-TW")).toBe("繁體中文翻譯")
    expect(getDisplayLanguageLabel("de")).toBe("Deutsche Übersetzung")
    expect(getDisplayLanguageLabel("fr")).toBe("Traduction française")
    expect(getDisplayLanguageLabel("es")).toBe("Traducción al español")
  })

  test("unknown codes fall back to Translation (<displayLanguage>)", () => {
    expect(getDisplayLanguageLabel("it")).toBe("Translation (it)")
  })
})
