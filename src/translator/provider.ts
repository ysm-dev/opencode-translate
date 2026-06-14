import { type AuthInfo, type FetchLike, PLUGIN_NAME, type ProviderInfo, type ProviderModelInfo } from "../constants"

const providerFactoryCache = new Map<string, unknown>()

const PROVIDER_PACKAGE_FALLBACK: Record<string, string> = {
  anthropic: "@ai-sdk/anthropic",
  openai: "@ai-sdk/openai",
  google: "@ai-sdk/google",
  "google-vertex": "@ai-sdk/google-vertex",
  "amazon-bedrock": "@ai-sdk/amazon-bedrock",
  "github-copilot": "@ai-sdk/openai-compatible",
}

const CREATE_EXPORT_FALLBACK: Record<string, string[]> = {
  "@ai-sdk/amazon-bedrock": ["createAmazonBedrock", "bedrock"],
  "@ai-sdk/anthropic": ["createAnthropic", "anthropic"],
  "@ai-sdk/azure": ["createAzure", "azure"],
  "@ai-sdk/gateway": ["createGateway", "gateway"],
  "@ai-sdk/google": ["createGoogleGenerativeAI", "google"],
  "@ai-sdk/google-vertex": ["createVertex", "vertex"],
  "@ai-sdk/openai": ["createOpenAI", "openai"],
  "@ai-sdk/openai-compatible": ["createOpenAICompatible"],
  "@openrouter/ai-sdk-provider": ["createOpenRouter", "openrouter"],
}

const PROVIDER_OPTIONS_KEY: Record<string, string> = {
  "@ai-sdk/amazon-bedrock": "bedrock",
  "@ai-sdk/amazon-bedrock/mantle": "openai",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/azure": "openai",
  "@ai-sdk/gateway": "gateway",
  "@ai-sdk/github-copilot": "openai",
  "@ai-sdk/google": "google",
  "@ai-sdk/google-vertex": "vertex",
  "@ai-sdk/google-vertex/anthropic": "anthropic",
  "@ai-sdk/openai": "openai",
  "@openrouter/ai-sdk-provider": "openrouter",
  "ai-gateway-provider": "openaiCompatible",
}

type JsonValue = null | string | number | boolean | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue | undefined }
type JsonArray = JsonValue[]
type VariantProviderOptions = Record<string, JsonObject>

interface ProviderCredentials {
  provider?: ProviderInfo
  authInfo?: AuthInfo
  apiKey?: string
  fetch?: FetchLike
}

export function __resetProviderFactoryCacheForTest() {
  providerFactoryCache.clear()
}

function providerPackage(providerID: string, model?: ProviderModelInfo): string {
  const packageName = model?.api?.npm || PROVIDER_PACKAGE_FALLBACK[providerID]
  if (!packageName) throw new Error(`Unsupported translator provider "${providerID}"`)
  return packageName
}

function pickFactory(mod: Record<string, unknown>, packageName: string): unknown {
  for (const key of CREATE_EXPORT_FALLBACK[packageName] ?? []) {
    if (typeof mod[key] === "function") return mod[key]
  }
  const createKey = Object.keys(mod).find((key) => key.startsWith("create") && typeof mod[key] === "function")
  return createKey ? mod[createKey] : undefined
}

export async function loadFactory(providerID: string, model?: ProviderModelInfo): Promise<unknown> {
  const packageName = providerPackage(providerID, model)
  const cached = providerFactoryCache.get(packageName)
  if (cached) return cached

  let mod: Record<string, unknown>
  try {
    mod = (await import(packageName)) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Unable to load provider package "${packageName}" for "${providerID}": ${String(error)}`)
  }
  const factory = pickFactory(mod, packageName)

  if (typeof factory !== "function") {
    throw new Error(`Unable to load provider factory from "${packageName}" for "${providerID}"`)
  }

  providerFactoryCache.set(packageName, factory)
  return factory
}

export function resolveModelInfo(provider: ProviderInfo | undefined, modelID: string): ProviderModelInfo {
  return provider?.models?.[modelID] ?? { id: modelID, api: { id: modelID } }
}

function sdkProviderOptionsKey(providerID: string, model?: ProviderModelInfo): string {
  const packageName = model?.api?.npm
  if (packageName && PROVIDER_OPTIONS_KEY[packageName]) return PROVIDER_OPTIONS_KEY[packageName]
  if (packageName === "@ai-sdk/openai-compatible" || packageName === "@ai-sdk/openai") return providerID.split(".")[0]
  return providerID
}

function invalidVariantError(providerID: string, modelID: string, model: ProviderModelInfo, variant: string) {
  const variants = Object.keys(model.variants ?? {}).sort()
  const modelName = `${providerID}/${modelID}`
  if (variants.length === 0) {
    return new Error(
      `[${PLUGIN_NAME}:INVALID_VARIANT] options.variant "${variant}" is not available for "${modelName}". This model has no configurable variants.`,
    )
  }
  return new Error(
    `[${PLUGIN_NAME}:INVALID_VARIANT] options.variant "${variant}" is not available for "${modelName}". Available variants: ${variants.join(", ")}.`,
  )
}

export function buildVariantProviderOptions(
  providerID: string,
  modelID: string,
  model: ProviderModelInfo,
  variant?: string,
): VariantProviderOptions | undefined {
  if (!variant) return undefined
  const selected = model.variants?.[variant]
  if (!selected) throw invalidVariantError(providerID, modelID, model, variant)
  const providerOptions = selected as JsonObject
  if (model.api?.npm === "@ai-sdk/azure") return { openai: providerOptions, azure: providerOptions }
  return { [sdkProviderOptionsKey(providerID, model)]: providerOptions }
}

function headerRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string"
    }),
  )
}

function substitutionVars(options: Record<string, unknown>, authInfo?: AuthInfo): Record<string, string | undefined> {
  const metadata = authInfo?.type === "api" ? authInfo.metadata : undefined
  const location =
    stringOption(options.location) ?? process.env.GOOGLE_VERTEX_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION
  const vertexEndpoint =
    location === "global" ? "aiplatform.googleapis.com" : location ? `${location}-aiplatform.googleapis.com` : undefined
  return {
    ...process.env,
    AZURE_RESOURCE_NAME:
      stringOption(options.resourceName) ?? metadata?.resourceName ?? process.env.AZURE_RESOURCE_NAME,
    GOOGLE_VERTEX_PROJECT:
      stringOption(options.project) ??
      process.env.GOOGLE_VERTEX_PROJECT ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      process.env.GCP_PROJECT ??
      process.env.GCLOUD_PROJECT,
    GOOGLE_VERTEX_LOCATION: location,
    GOOGLE_VERTEX_ENDPOINT: vertexEndpoint ?? process.env.GOOGLE_VERTEX_ENDPOINT,
    CLOUDFLARE_ACCOUNT_ID: metadata?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_GATEWAY_ID: metadata?.gatewayId ?? process.env.CLOUDFLARE_GATEWAY_ID,
  }
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function resolveBaseURL(baseURL: unknown, apiURL: unknown, options: Record<string, unknown>, authInfo?: AuthInfo) {
  let url = stringOption(baseURL) ?? stringOption(apiURL)
  if (!url) return undefined
  const vars = substitutionVars(options, authInfo)
  url = url.replace(/\$\{([^}]+)\}/g, (match, key) => vars[String(key)] ?? match)
  return url
}

function wrapSSE(response: Response, ms: number, controller: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return response
  if (!response.body) return response
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const error = new Error("SSE read timed out")
          controller.abort(error)
          void reader.cancel(error)
          reject(error)
        }, ms)

        reader.read().then(
          (value) => {
            clearTimeout(id)
            resolve(value)
          },
          (error) => {
            clearTimeout(id)
            reject(error)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      controller.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(response.headers),
    status: response.status,
    statusText: response.statusText,
  })
}

function anySignal(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  const signalAny = (AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal }).any
  return signalAny ? signalAny(signals) : signals[0]
}

function stripOpenAIItemIDs(packageName: string, init: RequestInit) {
  if (packageName !== "@ai-sdk/openai" && packageName !== "@ai-sdk/azure") return
  if (!init.body || init.method !== "POST" || typeof init.body !== "string") return
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (body.store === true || !Array.isArray(body.input)) return
    for (const item of body.input) {
      if (item && typeof item === "object" && !Array.isArray(item)) delete (item as Record<string, unknown>).id
    }
    init.body = JSON.stringify(body)
  } catch {}
}

function withOpenCodeFetch(config: Record<string, unknown>, packageName: string) {
  const configuredFetch = typeof config.fetch === "function" ? (config.fetch as FetchLike) : undefined
  const chunkTimeout = typeof config.chunkTimeout === "number" ? config.chunkTimeout : undefined
  delete config.chunkTimeout

  config.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit = { ...(init ?? {}) }
    const signals: AbortSignal[] = []
    const chunkController = chunkTimeout && chunkTimeout > 0 ? new AbortController() : undefined
    if (requestInit.signal) signals.push(requestInit.signal)
    if (chunkController) signals.push(chunkController.signal)
    if (typeof config.timeout === "number" && config.timeout > 0) signals.push(AbortSignal.timeout(config.timeout))
    const signal = anySignal(signals)
    if (signal) requestInit.signal = signal
    stripOpenAIItemIDs(packageName, requestInit)

    const response = await (configuredFetch ?? fetch)(input, { ...requestInit, timeout: false } as RequestInit)
    return chunkController && chunkTimeout ? wrapSSE(response, chunkTimeout, chunkController) : response
  }
}

function providerConfig(
  providerID: string,
  credentials: ProviderCredentials,
  model?: ProviderModelInfo,
): Record<string, unknown> {
  const provider = credentials.provider
  const packageName = providerPackage(providerID, model)
  const config: Record<string, unknown> = { ...(provider?.options ?? {}) }

  if (providerID === "google-vertex" && !packageName.includes("@ai-sdk/openai-compatible")) delete config.fetch
  if (packageName.includes("@ai-sdk/openai-compatible") && config.includeUsage !== false) config.includeUsage = true

  const baseURL = resolveBaseURL(config.baseURL, model?.api?.url, config, credentials.authInfo)
  if (baseURL !== undefined) config.baseURL = baseURL
  if (credentials.apiKey !== undefined) config.apiKey = credentials.apiKey
  if (credentials.fetch) config.fetch = credentials.fetch
  if (model?.headers) config.headers = { ...headerRecord(config.headers), ...model.headers }
  if (providerID === "github-copilot" && config.baseURL === undefined) config.baseURL = "https://api.githubcopilot.com"
  if (
    providerID === "amazon-bedrock" &&
    credentials.authInfo?.type === "api" &&
    !process.env.AWS_BEARER_TOKEN_BEDROCK
  ) {
    process.env.AWS_BEARER_TOKEN_BEDROCK = credentials.authInfo.key
  }

  withOpenCodeFetch(config, packageName)
  return { name: providerID, ...config }
}

export function instantiateProvider(
  factory: unknown,
  providerID: string,
  credentials: ProviderCredentials,
  model?: ProviderModelInfo,
): unknown {
  if (typeof factory !== "function") throw new Error(`Invalid provider factory for "${providerID}"`)
  return (factory as (config: Record<string, unknown>) => unknown)(providerConfig(providerID, credentials, model))
}

function shouldUseCopilotResponsesApi(modelID: string): boolean {
  const match = /^gpt-(\d+)/.exec(modelID)
  if (!match) return false
  return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
}

function selectAzureLanguageModel(record: Record<string, unknown>, modelID: string, useChat: boolean): unknown {
  if (useChat && typeof record.chat === "function") return (record.chat as (id: string) => unknown)(modelID)
  if (typeof record.responses === "function") return (record.responses as (id: string) => unknown)(modelID)
  if (typeof record.messages === "function") return (record.messages as (id: string) => unknown)(modelID)
  if (typeof record.chat === "function") return (record.chat as (id: string) => unknown)(modelID)
  if (typeof record.languageModel === "function") return (record.languageModel as (id: string) => unknown)(modelID)
}

function bedrockModelID(modelID: string, region: unknown): string {
  const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
  if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) return modelID
  if (typeof region !== "string") return modelID

  let regionPrefix = region.split("-")[0]
  if (regionPrefix === "us") {
    const modelRequiresPrefix = [
      "nova-micro",
      "nova-lite",
      "nova-pro",
      "nova-premier",
      "nova-2",
      "claude",
      "deepseek",
    ].some((value) => modelID.includes(value))
    if (modelRequiresPrefix && !region.startsWith("us-gov")) return `${regionPrefix}.${modelID}`
  }
  if (regionPrefix === "eu") {
    const regionRequiresPrefix = [
      "eu-west-1",
      "eu-west-2",
      "eu-west-3",
      "eu-north-1",
      "eu-central-1",
      "eu-south-1",
      "eu-south-2",
    ].some((value) => region.includes(value))
    const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((value) =>
      modelID.includes(value),
    )
    if (regionRequiresPrefix && modelRequiresPrefix) return `${regionPrefix}.${modelID}`
  }
  if (regionPrefix === "ap") {
    const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
    const isTokyoRegion = region === "ap-northeast-1"
    if (
      isAustraliaRegion &&
      ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((value) => modelID.includes(value))
    ) {
      regionPrefix = "au"
      return `${regionPrefix}.${modelID}`
    }
    const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((value) =>
      modelID.includes(value),
    )
    if (modelRequiresPrefix) return `${isTokyoRegion ? "jp" : "apac"}.${modelID}`
  }
  return modelID
}

export function instantiateModel(
  provider: unknown,
  modelID: string,
  providerID?: string,
  model?: ProviderModelInfo,
  providerOptions?: Record<string, unknown>,
): unknown {
  const apiID = model?.api?.id || model?.id || modelID
  if (typeof provider === "function") return provider(modelID)
  if (provider && typeof provider === "object") {
    const record = provider as Record<string, unknown>
    if ((providerID === "openai" || providerID === "xai") && typeof record.responses === "function") {
      return (record.responses as (id: string) => unknown)(apiID)
    }
    if (
      providerID === "github-copilot" &&
      typeof record.responses === "function" &&
      typeof record.chat === "function"
    ) {
      return shouldUseCopilotResponsesApi(apiID)
        ? (record.responses as (id: string) => unknown)(apiID)
        : (record.chat as (id: string) => unknown)(apiID)
    }
    if (providerID === "azure" || providerID === "azure-cognitive-services") {
      const selected = selectAzureLanguageModel(record, apiID, providerOptions?.useCompletionUrls === true)
      if (selected) return selected
    }
    if (providerID === "amazon-bedrock" && typeof record.languageModel === "function") {
      return (record.languageModel as (id: string) => unknown)(bedrockModelID(apiID, providerOptions?.region))
    }
    if (typeof record.chatModel === "function") return (record.chatModel as (id: string) => unknown)(modelID)
    if (typeof record.languageModel === "function") return (record.languageModel as (id: string) => unknown)(apiID)
    if (typeof record.chat === "function") return (record.chat as (id: string) => unknown)(apiID)
    if (typeof record.responses === "function") return (record.responses as (id: string) => unknown)(apiID)
  }
  throw new Error(`Unable to instantiate model "${modelID}"`)
}

export function supportsTemperature(providerID: string, modelID: string, model?: ProviderModelInfo): boolean {
  if (typeof model?.capabilities?.temperature === "boolean") return model.capabilities.temperature
  if (providerID !== "openai") return true
  if (modelID.startsWith("o1") || modelID.startsWith("o3") || modelID.startsWith("o4-mini")) return false
  return !(modelID.startsWith("gpt-5") && !modelID.startsWith("gpt-5-chat"))
}
