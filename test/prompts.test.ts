import { describe, expect, test } from "bun:test"
import {
  buildBatchSystemPrompt,
  buildBatchUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  parseBatchSegments,
  unwrapEchoedTextEnvelope,
} from "../src/prompts"

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

  test("batch prompts wrap text in indexed segments", () => {
    expect(buildBatchSystemPrompt({ sourceLanguage: "English", targetLanguage: "Korean", texts: ["Hello"] })).toContain(
      'segment index="N"',
    )
    expect(buildBatchUserPrompt({ texts: ["Hello", "Line\nTwo"] })).toBe(
      '<segment index="1">\nHello\n</segment>\n<segment index="2">\nLine\nTwo\n</segment>',
    )
  })

  test("parseBatchSegments restores ordered segment text", () => {
    expect(
      parseBatchSegments('<segment index="1">\r\n안녕\r\n</segment>\n<segment index="2">\n세계\n</segment>', 2),
    ).toEqual(["안녕", "세계"])
  })

  test("parseBatchSegments rejects malformed output", () => {
    expect(() => parseBatchSegments('<segment index="1">\n안녕\n</segment>', 2)).toThrow("segment index 2")
    expect(() => parseBatchSegments('note\n<segment index="1">\n안녕\n</segment>', 1)).toThrow("outside segment")
  })
})
