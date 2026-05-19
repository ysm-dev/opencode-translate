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

  test("loadFactory handles dynamic import edge cases", async () => {
    const genericFactory = await loadFactory("custom-provider", { api: { npm: "ai" } })
    expect(typeof genericFactory).toBe("function")

    await expect(loadFactory("custom-provider", { api: { npm: "node:fs/promises" } })).rejects.toThrow(
      'Unable to load provider factory from "node:fs/promises" for "custom-provider"',
    )
    await expect(
      loadFactory("custom-provider", { api: { npm: "missing-opencode-translate-provider" } }),
    ).rejects.toThrow('Unable to load provider package "missing-opencode-translate-provider" for "custom-provider"')
  })
})

describe("translator provider instantiation", () => {
  test("instantiateProvider passes credentials and GitHub Copilot base URL", () => {
    const calls: Record<string, unknown>[] = []
    const fetchCalls: string[] = []
    const fetchImpl = async () => new Response("ok")
    const factory = (config: Record<string, unknown>) => {
      calls.push(config)
      return { config }
    }

    const normalProvider = instantiateProvider(factory, "openai", { apiKey: "key", fetch: fetchImpl }) as {
      config: Record<string, unknown>
    }
    expect(normalProvider.config.apiKey).toBe("key")
    expect(typeof normalProvider.config.fetch).toBe("function")

    const observedProvider = instantiateProvider(factory, "openai", {
      fetch: async (input) => {
        fetchCalls.push(input instanceof URL ? input.href : String(input))
        return new Response("ok")
      },
    }) as { config: Record<string, unknown> }
    ;(observedProvider.config.fetch as typeof fetch)("https://example.com")
    expect(fetchCalls).toEqual(["https://example.com"])

    instantiateProvider(factory, "github-copilot", { apiKey: "copilot-key", fetch: fetchImpl })
    expect(calls[2].apiKey).toBe("copilot-key")
    expect(calls[2].name).toBe("github-copilot")
    expect(calls[2].baseURL).toBe("https://api.githubcopilot.com")
    expect(typeof calls[2].fetch).toBe("function")
  })

  test("instantiateProvider rejects invalid factories", () => {
    expect(() => instantiateProvider({}, "openai", {})).toThrow('Invalid provider factory for "openai"')
  })

  test("instantiateProvider applies OpenCode provider and model metadata", () => {
    process.env.OPENCODE_TRANSLATE_TEST_PATH = "v1"
    try {
      const placeholder = "$" + "{OPENCODE_TRANSLATE_TEST_PATH}"
      const provider = instantiateProvider(
        (config: Record<string, unknown>) => ({ config }),
        "custom-provider",
        {
          provider: {
            id: "custom-provider",
            source: "config",
            env: [],
            options: { headers: { "x-provider": "provider" } },
          },
        },
        {
          id: "alias-model",
          api: {
            id: "real-model",
            npm: "@ai-sdk/openai-compatible",
            url: `https://example.com/${placeholder}`,
          },
          headers: { "x-model": "model" },
        },
      ) as { config: Record<string, unknown> }

      expect(provider.config.name).toBe("custom-provider")
      expect(provider.config.baseURL).toBe("https://example.com/v1")
      expect(provider.config.includeUsage).toBe(true)
      expect(provider.config.headers).toEqual({ "x-provider": "provider", "x-model": "model" })
    } finally {
      delete process.env.OPENCODE_TRANSLATE_TEST_PATH
    }
  })

  test("instantiateProvider applies OpenCode fetch wrapping", async () => {
    let finalBody = ""
    const provider = instantiateProvider(
      (config: Record<string, unknown>) => ({ config }),
      "openai",
      {
        provider: {
          id: "openai",
          source: "config",
          env: [],
          options: {
            timeout: 1000,
            chunkTimeout: 1000,
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              finalBody = String(init?.body)
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("data: ok\n\n"))
                    controller.close()
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              )
            },
          },
        },
      },
      { api: { npm: "@ai-sdk/openai" } },
    ) as { config: Record<string, unknown> }

    const response = await (provider.config.fetch as typeof fetch)("https://example.com", {
      method: "POST",
      signal: new AbortController().signal,
      body: JSON.stringify({ input: [{ id: "item_1", text: "hello" }] }),
    })

    expect(await response.text()).toBe("data: ok\n\n")
    expect(finalBody).toBe(JSON.stringify({ input: [{ text: "hello" }] }))
    expect(provider.config.chunkTimeout).toBeUndefined()
  })

  test("instantiateProvider enforces SSE chunk timeout", async () => {
    const provider = instantiateProvider(
      (config: Record<string, unknown>) => ({ config }),
      "openai",
      {
        provider: {
          id: "openai",
          source: "config",
          env: [],
          options: {
            chunkTimeout: 1,
            fetch: async () => {
              return new Response(new ReadableStream<Uint8Array>(), {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              })
            },
          },
        },
      },
      { api: { npm: "@ai-sdk/openai" } },
    ) as { config: Record<string, unknown> }

    const response = await (provider.config.fetch as typeof fetch)("https://example.com")
    await expect(response.text()).rejects.toThrow("SSE read timed out")
  })

  test("instantiateProvider propagates SSE read errors and cancellation", async () => {
    const readErrorProvider = instantiateProvider(
      (config: Record<string, unknown>) => ({ config }),
      "openai",
      {
        provider: {
          id: "openai",
          source: "config",
          env: [],
          options: {
            chunkTimeout: 1000,
            fetch: async () => {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.error(new Error("read failed"))
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              )
            },
          },
        },
      },
      { api: { npm: "@ai-sdk/openai" } },
    ) as { config: Record<string, unknown> }

    const failedResponse = await (readErrorProvider.config.fetch as typeof fetch)("https://example.com")
    await expect(failedResponse.text()).rejects.toThrow("read failed")

    let cancelledReason: unknown
    const cancelProvider = instantiateProvider(
      (config: Record<string, unknown>) => ({ config }),
      "openai",
      {
        provider: {
          id: "openai",
          source: "config",
          env: [],
          options: {
            chunkTimeout: 1000,
            fetch: async () => {
              return new Response(
                new ReadableStream<Uint8Array>({
                  cancel(reason) {
                    cancelledReason = reason
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              )
            },
          },
        },
      },
      { api: { npm: "@ai-sdk/openai" } },
    ) as { config: Record<string, unknown> }

    const cancelledResponse = await (cancelProvider.config.fetch as typeof fetch)("https://example.com")
    await cancelledResponse.body?.cancel("stop")
    expect(cancelledReason).toBe("stop")
  })

  test("instantiateProvider exposes API auth to Bedrock bearer-token env", () => {
    const original = process.env.AWS_BEARER_TOKEN_BEDROCK
    delete process.env.AWS_BEARER_TOKEN_BEDROCK
    try {
      instantiateProvider((config: Record<string, unknown>) => ({ config }), "amazon-bedrock", {
        authInfo: { type: "api", key: "bedrock-token" },
      })
      expect((process.env as Record<string, unknown>).AWS_BEARER_TOKEN_BEDROCK).toBe("bedrock-token")
    } finally {
      if (original === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK
      else process.env.AWS_BEARER_TOKEN_BEDROCK = original
    }
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

  test("instantiateModel follows OpenCode model loader conventions", () => {
    expect(
      instantiateModel({ responses: (id: string) => ({ kind: "responses", id }) }, "alias-model", "openai", {
        api: { id: "real-model" },
      }),
    ).toEqual({ kind: "responses", id: "real-model" })

    expect(
      instantiateModel(
        { responses: (id: string) => ({ kind: "responses", id }), chat: (id: string) => ({ kind: "chat", id }) },
        "gpt-5.5",
        "github-copilot",
      ),
    ).toEqual({ kind: "responses", id: "gpt-5.5" })

    expect(
      instantiateModel(
        { responses: (id: string) => ({ kind: "responses", id }), chat: (id: string) => ({ kind: "chat", id }) },
        "gpt-4o",
        "github-copilot",
      ),
    ).toEqual({ kind: "chat", id: "gpt-4o" })
  })

  test("instantiateModel follows Azure and Bedrock OpenCode conventions", () => {
    expect(
      instantiateModel({ chat: (id: string) => ({ kind: "chat", id }) }, "model", "azure", undefined, {
        useCompletionUrls: true,
      }),
    ).toEqual({ kind: "chat", id: "model" })
    expect(instantiateModel({ responses: (id: string) => ({ kind: "responses", id }) }, "model", "azure")).toEqual({
      kind: "responses",
      id: "model",
    })
    expect(instantiateModel({ messages: (id: string) => ({ kind: "messages", id }) }, "model", "azure")).toEqual({
      kind: "messages",
      id: "model",
    })
    expect(instantiateModel({ chat: (id: string) => ({ kind: "chat", id }) }, "model", "azure")).toEqual({
      kind: "chat",
      id: "model",
    })
    expect(instantiateModel({ languageModel: (id: string) => ({ kind: "language", id }) }, "model", "azure")).toEqual({
      kind: "language",
      id: "model",
    })

    const bedrock = { languageModel: (id: string) => ({ kind: "bedrock", id }) }
    expect(
      instantiateModel(bedrock, "anthropic.claude-haiku", "amazon-bedrock", undefined, { region: "us-east-1" }),
    ).toEqual({ kind: "bedrock", id: "us.anthropic.claude-haiku" })
    expect(
      instantiateModel(bedrock, "anthropic.claude-haiku", "amazon-bedrock", undefined, { region: "eu-west-1" }),
    ).toEqual({ kind: "bedrock", id: "eu.anthropic.claude-haiku" })
    expect(
      instantiateModel(bedrock, "anthropic.claude-haiku", "amazon-bedrock", undefined, { region: "ap-southeast-2" }),
    ).toEqual({ kind: "bedrock", id: "au.anthropic.claude-haiku" })
    expect(
      instantiateModel(bedrock, "anthropic.claude-haiku", "amazon-bedrock", undefined, { region: "ap-northeast-1" }),
    ).toEqual({ kind: "bedrock", id: "jp.anthropic.claude-haiku" })
    expect(instantiateModel(bedrock, "global.anthropic.claude-haiku", "amazon-bedrock")).toEqual({
      kind: "bedrock",
      id: "global.anthropic.claude-haiku",
    })
  })

  test("supportsTemperature disables unsupported OpenAI reasoning models", () => {
    expect(supportsTemperature("custom", "model", { capabilities: { temperature: false } })).toBe(false)
    expect(supportsTemperature("anthropic", "claude-haiku-4-5")).toBe(true)
    expect(supportsTemperature("openai", "gpt-4.1")).toBe(true)
    expect(supportsTemperature("openai", "gpt-5-chat-latest")).toBe(true)
    expect(supportsTemperature("openai", "gpt-5.5")).toBe(false)
    expect(supportsTemperature("openai", "o1-preview")).toBe(false)
    expect(supportsTemperature("openai", "o3-mini")).toBe(false)
    expect(supportsTemperature("openai", "o4-mini")).toBe(false)
  })
})
