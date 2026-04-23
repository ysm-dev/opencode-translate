import { createHash, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { generateText } from "ai"
import { createCredentialResolver } from "./auth"
import {
  buildAuthUnavailableError,
  type FetchLike,
  normalizeReason,
  PLUGIN_NAME,
  type PluginClientLike,
  type ProviderInfo,
  parseTranslatorModel,
  type ResolvedTranslateOptions,
} from "./constants"
import { buildSystemPrompt, buildUserPrompt } from "./prompts"
import { protectText, restoreProtectedText } from "./protect"

interface TranslatorDependencies {
  generateTextImpl?: typeof generateText
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  credentialResolver?: ReturnType<typeof createCredentialResolver>
}

interface TranslateTextInput {
  text: string
  sourceLanguage: string
  targetLanguage: string
  direction: "inbound" | "outbound"
}

const providerFactoryCache = new Map<string, unknown>()

export function __resetTranslatorCachesForTest() {
  providerFactoryCache.clear()
}

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  if (typeof record.status === "number") return record.status
  if (typeof record.statusCode === "number") return record.statusCode
  const response = record.response
  if (response && typeof response === "object") {
    const status = (response as Record<string, unknown>).status
    if (typeof status === "number") return status
  }
  return undefined
}

function getRetryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 2000
  const record = error as Record<string, unknown>
  const response = record.response
  if (!response || typeof response !== "object") return 2000
  const headers = (response as { headers?: Headers }).headers
  if (!(headers instanceof Headers)) return 2000
  const retryAfter = headers.get("retry-after")
  if (!retryAfter) return 2000
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 2000
}

function isRetryable(error: unknown): boolean {
  const status = getStatus(error)
  if (status === 429) return true
  if (status !== undefined) return status >= 500
  const message = normalizeReason(error).toLowerCase()
  return (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("socket") ||
    message.includes("econn")
  )
}

async function withRetry<T>(task: () => Promise<T>, sleepImpl: (ms: number) => Promise<void>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error
      if (getStatus(error) === 429) {
        if (attempt >= 1) throw error
        await sleepImpl(getRetryAfterMs(error))
        continue
      }
      if (attempt >= 2) throw error
      await sleepImpl(attempt === 0 ? 500 : 1500)
    }
  }
  throw lastError
}

async function loadFactory(providerID: string): Promise<unknown> {
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

function instantiateProvider(
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

function instantiateModel(provider: unknown, modelID: string): unknown {
  if (typeof provider === "function") return provider(modelID)
  if (provider && typeof provider === "object") {
    const record = provider as Record<string, unknown>
    if (typeof record.chatModel === "function") return (record.chatModel as (id: string) => unknown)(modelID)
    if (typeof record.languageModel === "function") {
      return (record.languageModel as (id: string) => unknown)(modelID)
    }
  }
  throw new Error(`Unable to instantiate model "${modelID}"`)
}

function isAuthMessage(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes(":AUTH_UNAVAILABLE]") || error.message.includes(":OAUTH_REFRESH_FAILED]")
}

function modelProviderHint(providerID: string, provider?: ProviderInfo): Error {
  return buildAuthUnavailableError(providerID, provider?.env[0] || "the provider's API key env var")
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)
}

export function createSyntheticPartID(): string {
  return `prt_${randomUUID().replaceAll("-", "")}`
}

export function createTranslator(
  client: PluginClientLike,
  options: ResolvedTranslateOptions,
  deps: TranslatorDependencies = {},
) {
  const sleepImpl = deps.sleep ?? ((ms: number) => sleep(ms))
  const now = deps.now ?? (() => Date.now())
  const generateTextImpl = deps.generateTextImpl ?? generateText
  const credentialResolver = deps.credentialResolver ?? createCredentialResolver(client, options)

  async function translateText(input: TranslateTextInput): Promise<string> {
    if (!input.text) return input.text
    if (input.sourceLanguage === input.targetLanguage) return input.text

    const startedAt = now()
    const { providerID, modelID } = parseTranslatorModel(options.translatorModel)
    const credentials = await credentialResolver.resolve(options.translatorModel)
    const factory = await loadFactory(providerID)
    const provider = instantiateProvider(factory, providerID, credentials)
    const model = instantiateModel(provider, modelID)
    const protectedText = protectText(input.text)

    let missingPlaceholders: string[] | undefined
    let lastError: unknown

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const translated = await withRetry(async () => {
          try {
            const result = (await generateTextImpl({
              model: model as never,
              system: buildSystemPrompt({
                sourceLanguage: input.sourceLanguage,
                targetLanguage: input.targetLanguage,
                text: protectedText.text,
                strictPlaceholderRetry: missingPlaceholders,
              }),
              temperature: 0,
              prompt: buildUserPrompt({
                sourceLanguage: input.sourceLanguage,
                targetLanguage: input.targetLanguage,
                text: protectedText.text,
              }),
            })) as { text: string }
            return result.text
          } catch (error) {
            if (isAuthMessage(error)) throw error
            if (credentials.mode === "default" && credentialResolver.isMissingCredentialError(error)) {
              throw modelProviderHint(providerID, credentials.provider)
            }
            throw error
          }
        }, sleepImpl)

        const restored = restoreProtectedText(protectedText, translated)
        if (!restored.ok) {
          missingPlaceholders =
            restored.missing.length > 0 ? restored.missing : protectedText.placeholders.map((item) => item.token)
          lastError = new Error(`Protection check failed: ${restored.reason}`)
          continue
        }

        if (options.verbose) {
          await client.app.log({
            body: {
              service: PLUGIN_NAME,
              level: "info",
              message: "translated",
              extra: {
                direction: input.direction,
                chars_in: input.text.length,
                chars_out: restored.text.length,
                ms: now() - startedAt,
                cached: false,
                model: options.translatorModel,
              },
            },
          })
        }

        return restored.text
      } catch (error) {
        if (isAuthMessage(error)) throw error
        lastError = error
      }
    }

    if (lastError instanceof Error && lastError.message.includes(":AUTH_UNAVAILABLE]")) {
      throw lastError
    }
    if (lastError instanceof Error && lastError.message.includes(":OAUTH_REFRESH_FAILED]")) {
      throw lastError
    }
    throw new Error(normalizeReason(lastError))
  }

  return {
    translateText,
  }
}
