import { setTimeout as sleep } from "node:timers/promises"
import { generateText } from "ai"
import { createCredentialResolver } from "../auth"
import {
  buildAuthUnavailableError,
  PLUGIN_NAME,
  type PluginClientLike,
  type ProviderInfo,
  parseTranslatorModel,
  type ResolvedTranslateOptions,
} from "../constants"
import { buildSystemPrompt, buildUserPrompt, unwrapEchoedTextEnvelope } from "../prompts"
import { __resetSyntheticPartIDForTest } from "./part-id"
import {
  __resetProviderFactoryCacheForTest,
  instantiateModel,
  instantiateProvider,
  loadFactory,
  supportsTemperature,
} from "./provider"
import { withRetry } from "./retry"
import type { TranslateTextInput, TranslatorDependencies } from "./types"

const DEFAULT_TRANSLATE_TIMEOUT_MS = 180_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isAuthMessage(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes(":AUTH_UNAVAILABLE]") || error.message.includes(":OAUTH_REFRESH_FAILED]")
}

function modelProviderHint(providerID: string, provider?: ProviderInfo): Error {
  return buildAuthUnavailableError(providerID, provider?.env[0] || "the provider's API key env var")
}

export function __resetTranslatorCachesForTest() {
  __resetProviderFactoryCacheForTest()
  __resetSyntheticPartIDForTest()
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
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS

  async function translateText(input: TranslateTextInput): Promise<string> {
    if (!input.text) return input.text
    if (input.sourceLanguage === input.targetLanguage) return input.text

    const startedAt = now()
    const { providerID, modelID } = parseTranslatorModel(options.translatorModel)
    const credentials = await credentialResolver.resolve(options.translatorModel)
    const factory = await loadFactory(providerID)
    const provider = instantiateProvider(factory, providerID, credentials)
    const model = instantiateModel(provider, modelID)

    const rawTranslated = await withRetry(async () => {
      try {
        const result = (await withTimeout(
          generateTextImpl({
            model: model as never,
            system: buildSystemPrompt(input),
            ...(supportsTemperature(providerID, modelID) ? { temperature: 0 } : {}),
            prompt: buildUserPrompt(input),
          }) as Promise<{ text: string }>,
          timeoutMs,
          "Translator generateText",
        )) as { text: string }
        return result.text
      } catch (error) {
        if (isAuthMessage(error)) throw error
        if (credentials.mode === "default" && credentialResolver.isMissingCredentialError(error)) {
          throw modelProviderHint(providerID, credentials.provider)
        }
        throw error
      }
    }, sleepImpl)
    const translated = unwrapEchoedTextEnvelope(rawTranslated)

    if (options.verbose) {
      await client.app.log({
        body: {
          service: PLUGIN_NAME,
          level: "info",
          message: "translated",
          extra: {
            direction: input.direction,
            chars_in: input.text.length,
            chars_out: translated.length,
            ms: now() - startedAt,
            cached: false,
            model: options.translatorModel,
          },
        },
      })
    }

    return translated
  }

  return { translateText }
}

export { __resetSyntheticPartIDForTest, createSyntheticPartID, hashText } from "./part-id"
