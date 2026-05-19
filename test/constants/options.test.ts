import { describe, expect, test } from "bun:test"
import { getEnvVarHint, parseTranslatorModel, resolveOptions } from "../../src/constants"

describe("option resolution", () => {
  test("resolveOptions sanitizes optional user configuration", () => {
    expect(
      resolveOptions({
        lang: "Korean",
        model: "  anthropic/claude-haiku-4-5  ",
        triggerKeywords: ["", "$go", 123],
        apiKey: "",
        verbose: "yes",
      }),
    ).toEqual({
      model: "anthropic/claude-haiku-4-5",
      triggerKeywords: ["$go"],
      lang: "Korean",
      apiKey: undefined,
      verbose: false,
    })
  })

  test("resolveOptions requires model", () => {
    expect(() => resolveOptions({ lang: "Korean" })).toThrow("options.model is required")
    expect(() => resolveOptions({ model: "  ", lang: "Korean" })).toThrow("options.model is required")
    expect(() => resolveOptions({ model: "missing-slash", lang: "Korean" })).toThrow(
      "options.model must be in provider/model-id form",
    )
  })

  test("resolveOptions requires lang", () => {
    expect(() => resolveOptions({ model: "anthropic/claude-haiku-4-5" })).toThrow("options.lang is required")
    expect(() => resolveOptions({ model: "anthropic/claude-haiku-4-5", lang: "  " })).toThrow(
      "options.lang is required",
    )
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
