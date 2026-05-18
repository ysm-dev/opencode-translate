import { setTimeout as sleep } from "node:timers/promises"
import {
  AUTH_ENV_FALLBACK,
  buildAuthUnavailableError,
  buildOAuthRefreshError,
  getEnvVarHint,
  normalizeReason,
  OAUTH_DUMMY_KEY,
  type OAuthInfo,
  type PluginClientLike,
  type ProviderInfo,
  parseTranslatorModel,
  type ResolvedTranslateOptions,
  unwrapData,
} from "../constants"
import { buildOAuthFetch } from "./oauth-fetch"
import { refreshAnthropic, refreshOpenAI } from "./refresh"
import { ensureOAuthInfo, normalizeProviderKey, readAuthMap } from "./store"
import type { AuthDependencies, AuthRuntime, ResolvedCredential } from "./types"

const credentialCache = new Map<string, ResolvedCredential>()
const oauthRefreshInflight = new Map<string, Promise<OAuthInfo>>()

export function __resetAuthCachesForTest() {
  credentialCache.clear()
  oauthRefreshInflight.clear()
}

function isMissingCredentialError(error: unknown): boolean {
  const message = normalizeReason(error).toLowerCase()
  return (
    message.includes("api key") ||
    message.includes("api-key") ||
    message.includes("missing credentials") ||
    message.includes("missing authentication") ||
    message.includes("missing auth") ||
    message.includes("no auth")
  )
}

async function refreshProviderOAuth(
  providerID: string,
  info: OAuthInfo,
  client: PluginClientLike,
  runtime: AuthRuntime,
) {
  let refreshed: OAuthInfo
  try {
    if (providerID === "anthropic") refreshed = await refreshAnthropic(info, runtime)
    else if (providerID === "openai") refreshed = await refreshOpenAI(info, runtime)
    else return info
  } catch (error) {
    if (error instanceof Error && error.message.includes(":OAUTH_REFRESH_FAILED]")) throw error
    throw buildOAuthRefreshError(providerID, normalizeReason(error))
  }

  await client.auth.set({ path: { id: providerID }, body: refreshed })
  return refreshed
}

async function getProvider(client: PluginClientLike, providerID: string): Promise<ProviderInfo | undefined> {
  try {
    const listed = unwrapData(await client.provider.list({ throwOnError: true }))
    return listed.all.find((provider) => provider.id === providerID)
  } catch {
    return undefined
  }
}

export function createCredentialResolver(
  client: PluginClientLike,
  options: ResolvedTranslateOptions,
  deps: AuthDependencies = {},
) {
  const runtime: AuthRuntime = {
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms: number) => sleep(ms)),
  }
  const now = deps.now ?? (() => Date.now())

  async function resolveOAuth(providerID: string): Promise<OAuthInfo | undefined> {
    const authMap = await readAuthMap(deps)
    const info = ensureOAuthInfo(authMap?.[providerID])
    if (!info) return undefined
    if (info.expires >= now() + 60_000) return info

    const existing = oauthRefreshInflight.get(providerID)
    if (existing) return existing

    const refreshPromise = refreshProviderOAuth(providerID, info, client, runtime).finally(() => {
      oauthRefreshInflight.delete(providerID)
    })
    oauthRefreshInflight.set(providerID, refreshPromise)
    return refreshPromise
  }

  function credentialFromOAuth(providerID: string, provider?: ProviderInfo): ResolvedCredential {
    return {
      providerID,
      provider,
      apiKey: "",
      fetch: buildOAuthFetch({ ...runtime, providerID, resolveOAuth, packageVersion: deps.packageVersion }),
      mode: "oauth",
    }
  }

  async function resolve(providerModel: string): Promise<ResolvedCredential> {
    const { providerID } = parseTranslatorModel(providerModel)
    const cached = credentialCache.get(providerID)
    if (cached) return cached

    const provider = await getProvider(client, providerID)
    if (options.apiKey) {
      const resolved = { providerID, provider, apiKey: options.apiKey, mode: "apiKey" as const }
      credentialCache.set(providerID, resolved)
      return resolved
    }

    const providerKey = normalizeProviderKey(provider?.key)
    if ((provider?.source === "api" || provider?.source === "env") && providerKey) {
      const resolved = { providerID, provider, apiKey: providerKey, mode: "apiKey" as const }
      credentialCache.set(providerID, resolved)
      return resolved
    }

    if (provider?.source === "custom" || provider?.key === OAUTH_DUMMY_KEY) {
      const oauthInfo = await resolveOAuth(providerID)
      if (oauthInfo) {
        const resolved = credentialFromOAuth(providerID, provider)
        credentialCache.set(providerID, resolved)
        return resolved
      }
    }

    if (provider?.key === undefined && (provider?.env.length ?? 0) > 1) {
      const resolved = { providerID, provider, mode: "default" as const }
      credentialCache.set(providerID, resolved)
      return resolved
    }

    return { providerID, provider, mode: "default" }
  }

  return {
    resolve,
    authUnavailable: (providerID: string, provider?: ProviderInfo) =>
      buildAuthUnavailableError(providerID, getEnvVarHint(provider)),
    isMissingCredentialError,
    envFallback: AUTH_ENV_FALLBACK,
  }
}

export type { AuthDependencies, ResolvedCredential }
