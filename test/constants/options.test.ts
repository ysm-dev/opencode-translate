import { describe, expect, test } from "bun:test"
import { getEnvVarHint, parseTranslatorModel, resolveOptions } from "../../src/constants"

describe("option resolution", () => {
  test("resolveOptions sanitizes invalid optional user configuration", () => {
    expect(
      resolveOptions({
        lang: "Korean",
        translatorModel: "missing-slash",
        triggerKeywords: ["", "$go", 123],
        apiKey: "",
        verbose: "yes",
      }),
    ).toEqual({
      translatorModel: "anthropic/claude-haiku-4-5",
      triggerKeywords: ["$go"],
      lang: "Korean",
      apiKey: undefined,
      verbose: false,
    })
  })

  test("resolveOptions requires lang", () => {
    expect(() => resolveOptions({ translatorModel: "anthropic/claude-haiku-4-5" })).toThrow("options.lang is required")
    expect(() => resolveOptions({ lang: "  " })).toThrow("options.lang is required")
  })

  test("parseTranslatorModel falls back to anthropic for bare model names", () => {
    expect(parseTranslatorModel("claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
    expect(parseTranslatorModel("openai/gpt-5.5")).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
  })

  test("getEnvVarHint uses provider-specific env names when available", () => {
    expect(getEnvVarHint({ id: "openai", source: "env", env: ["OPENAI_API_KEY"] })).toBe("OPENAI_API_KEY")
    expect(getEnvVarHint(undefined)).toBe("the provider's API key env var")
  })
})
