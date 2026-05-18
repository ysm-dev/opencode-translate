import { beforeEach, describe, expect, test } from "bun:test"
import {
  __resetProviderFactoryCacheForTest,
  instantiateModel,
  instantiateProvider,
  loadFactory,
  supportsTemperature,
} from "../../src/translator/provider"

describe("translator provider loading", () => {
  beforeEach(() => {
    __resetProviderFactoryCacheForTest()
  })

  test("loadFactory supports every configured provider and caches results", async () => {
    const providerIDs = ["anthropic", "openai", "google", "google-vertex", "amazon-bedrock", "github-copilot"]
    for (const providerID of providerIDs) {
      const factory = await loadFactory(providerID)
      expect(typeof factory).toBe("function")
    }

    const first = await loadFactory("openai")
    const second = await loadFactory("openai")
    expect(second).toBe(first)
  })

  test("loadFactory rejects unsupported providers", async () => {
    await expect(loadFactory("unknown-provider")).rejects.toThrow('Unsupported translator provider "unknown-provider"')
  })
})

describe("translator provider instantiation", () => {
  test("instantiateProvider passes credentials and GitHub Copilot base URL", () => {
    const calls: Record<string, unknown>[] = []
    const fetchImpl = async () => new Response("ok")
    const factory = (config: Record<string, unknown>) => {
      calls.push(config)
      return { config }
    }

    const normalProvider = instantiateProvider(factory, "openai", { apiKey: "key", fetch: fetchImpl }) as {
      config: Record<string, unknown>
    }
    expect(normalProvider.config.apiKey).toBe("key")
    expect(normalProvider.config.fetch).toBe(fetchImpl)

    instantiateProvider(factory, "github-copilot", { apiKey: "copilot-key", fetch: fetchImpl })
    expect(calls[1]).toEqual({
      apiKey: "copilot-key",
      fetch: fetchImpl,
      name: "github-copilot",
      baseURL: "https://api.githubcopilot.com",
    })
  })

  test("instantiateProvider rejects invalid factories", () => {
    expect(() => instantiateProvider({}, "openai", {})).toThrow('Invalid provider factory for "openai"')
  })

  test("instantiateModel supports callable, chatModel, and languageModel providers", () => {
    expect(instantiateModel((id: string) => ({ kind: "callable", id }), "model-a")).toEqual({
      kind: "callable",
      id: "model-a",
    })
    expect(instantiateModel({ chatModel: (id: string) => ({ kind: "chat", id }) }, "model-b")).toEqual({
      kind: "chat",
      id: "model-b",
    })
    expect(instantiateModel({ languageModel: (id: string) => ({ kind: "language", id }) }, "model-c")).toEqual({
      kind: "language",
      id: "model-c",
    })
    expect(() => instantiateModel({}, "model-d")).toThrow('Unable to instantiate model "model-d"')
  })

  test("supportsTemperature disables unsupported OpenAI reasoning models", () => {
    expect(supportsTemperature("anthropic", "claude-haiku-4-5")).toBe(true)
    expect(supportsTemperature("openai", "gpt-4.1")).toBe(true)
    expect(supportsTemperature("openai", "gpt-5-chat-latest")).toBe(true)
    expect(supportsTemperature("openai", "gpt-5.5")).toBe(false)
    expect(supportsTemperature("openai", "o1-preview")).toBe(false)
    expect(supportsTemperature("openai", "o3-mini")).toBe(false)
    expect(supportsTemperature("openai", "o4-mini")).toBe(false)
  })
})
