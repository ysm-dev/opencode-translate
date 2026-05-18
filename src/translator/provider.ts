import type { FetchLike } from "../constants"

const providerFactoryCache = new Map<string, unknown>()

export function __resetProviderFactoryCacheForTest() {
  providerFactoryCache.clear()
}

export async function loadFactory(providerID: string): Promise<unknown> {
  const cached = providerFactoryCache.get(providerID)
  if (cached) return cached

  let factory: unknown
  if (providerID === "anthropic") {
    const mod = await import("@ai-sdk/anthropic")
    factory = mod.createAnthropic ?? mod.anthropic
  } else if (providerID === "openai") {
    const mod = await import("@ai-sdk/openai")
    factory = mod.createOpenAI ?? mod.openai
  } else if (providerID === "google") {
    const mod = await import("@ai-sdk/google")
    factory = mod.createGoogleGenerativeAI ?? mod.google
  } else if (providerID === "google-vertex") {
    const mod = await import("@ai-sdk/google-vertex")
    factory = mod.createVertex ?? mod.vertex
  } else if (providerID === "amazon-bedrock") {
    const mod = await import("@ai-sdk/amazon-bedrock")
    factory = mod.createAmazonBedrock ?? mod.bedrock
  } else if (providerID === "github-copilot") {
    const mod = await import("@ai-sdk/openai-compatible")
    factory = mod.createOpenAICompatible
  } else {
    throw new Error(`Unsupported translator provider "${providerID}"`)
  }

  if (typeof factory !== "function") {
    throw new Error(`Unable to load provider factory for "${providerID}"`)
  }

  providerFactoryCache.set(providerID, factory)
  return factory
}

export function instantiateProvider(
  factory: unknown,
  providerID: string,
  credentials: { apiKey?: string; fetch?: FetchLike },
): unknown {
  if (typeof factory !== "function") throw new Error(`Invalid provider factory for "${providerID}"`)

  const config = {
    ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
    ...(credentials.fetch ? { fetch: credentials.fetch } : {}),
  }

  if (providerID === "github-copilot") {
    return (factory as (config: Record<string, unknown>) => unknown)({
      ...config,
      name: "github-copilot",
      baseURL: "https://api.githubcopilot.com",
    })
  }

  return (factory as (config: Record<string, unknown>) => unknown)(config)
}

export function instantiateModel(provider: unknown, modelID: string): unknown {
  if (typeof provider === "function") return provider(modelID)
  if (provider && typeof provider === "object") {
    const record = provider as Record<string, unknown>
    if (typeof record.chatModel === "function") return (record.chatModel as (id: string) => unknown)(modelID)
    if (typeof record.languageModel === "function") return (record.languageModel as (id: string) => unknown)(modelID)
  }
  throw new Error(`Unable to instantiate model "${modelID}"`)
}

export function supportsTemperature(providerID: string, modelID: string): boolean {
  if (providerID !== "openai") return true
  if (modelID.startsWith("o1") || modelID.startsWith("o3") || modelID.startsWith("o4-mini")) return false
  return !(modelID.startsWith("gpt-5") && !modelID.startsWith("gpt-5-chat"))
}
