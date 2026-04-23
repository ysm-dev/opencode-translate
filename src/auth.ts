import { readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import {
  AUTH_ENV_FALLBACK,
  type AuthInfo,
  buildAuthUnavailableError,
  buildOAuthRefreshError,
  type FetchLike,
  getEnvVarHint,
  normalizeReason,
  OAUTH_DUMMY_KEY,
  type OAuthInfo,
  type PluginClientLike,
  type ProviderInfo,
  parseTranslatorModel,
  type ResolvedTranslateOptions,
  USER_AGENT,
  unwrapData,
} from "./constants"

export interface ResolvedCredential {
  providerID: string
  provider?: ProviderInfo
  apiKey?: string
  fetch?: FetchLike
  mode: "apiKey" | "oauth" | "default"
}

interface AuthDependencies {
  fetchImpl?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>
  stat?: (filePath: string) => Promise<{ mode: number }>
  packageVersion?: string
}

const credentialCache = new Map<string, ResolvedCredential>()
const oauthRefreshInflight = new Map<string, Promise<OAuthInfo>>()

export function __resetAuthCachesForTest() {
  credentialCache.clear()
  oauthRefreshInflight.clear()
}

// opencode itself resolves `auth.json` through xdg-basedir (packages/opencode/src/global/index.ts:10).
// When XDG_DATA_HOME is unset, xdg-basedir returns `~/.local/share` on macOS and Linux, and
// %LOCALAPPDATA% on Windows. The spec's macOS fallback to `~/Library/Application Support` is only
// accurate if the user exports XDG_DATA_HOME themselves; in practice opencode stores auth.json at
// `~/.local/share/opencode/auth.json` on macOS, so we mirror that here.
function authFilePath(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome) return path.join(xdgDataHome, "opencode", "auth.json")
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode", "auth.json")
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

function copyHeaders(headers?: HeadersInit): Headers {
  return new Headers(headers)
}

function headerValue(headers: Headers, key: string): string | undefined {
  const value = headers.get(key)
  return value === null ? undefined : value
}

function setUserAgent(headers: Headers, packageVersion?: string) {
  headers.set("User-Agent", packageVersion ? `${USER_AGENT.replace("0.0.0", packageVersion)}` : USER_AGENT)
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

function getStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  if (typeof record.status === "number") return record.status
  if (typeof record.statusCode === "number") return record.statusCode
  const response = record.response
  if (response && typeof response === "object") {
    const maybeStatus = (response as Record<string, unknown>).status
    if (typeof maybeStatus === "number") return maybeStatus
  }
  return undefined
}

function getRetryAfterMs(error: unknown): number {
  if (!error || typeof error !== "object") return 2000
  const record = error as Record<string, unknown>
  const response = record.response
  if (response && typeof response === "object") {
    const headers = (response as { headers?: Headers }).headers
    if (headers instanceof Headers) {
      const retryAfter = headerValue(headers, "retry-after")
      if (!retryAfter) return 2000
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) return Math.max(0, date - Date.now())
    }
  }
  return 2000
}

function isRetryableError(error: unknown): boolean {
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

async function withRetry<T>(task: () => Promise<T>, deps: Required<Pick<AuthDependencies, "sleep">>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (!isRetryableError(error)) throw error
      if (getStatus(error) === 429) {
        if (attempt >= 1) throw error
        await deps.sleep(getRetryAfterMs(error))
        continue
      }
      if (attempt >= 2) throw error
      await deps.sleep(attempt === 0 ? 500 : 1500)
    }
  }
  throw lastError
}

function normalizeProviderKey(value: string | undefined): string | undefined {
  if (!value || value === OAUTH_DUMMY_KEY) return undefined
  return value
}

function ensureOAuthInfo(value: AuthInfo | undefined): OAuthInfo | undefined {
  return value && value.type === "oauth" ? value : undefined
}

async function readAuthMap(deps: AuthDependencies): Promise<Record<string, AuthInfo> | undefined> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      const parsed = JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, AuthInfo>
      if (parsed && typeof parsed === "object") return parsed
    } catch {}
    return undefined
  }

  const filePath = authFilePath()
  try {
    const fileStat = await (deps.stat ?? stat)(filePath)
    if ((fileStat.mode & 0o777) !== 0o600) return undefined
    const raw = await (deps.readFile ?? readFile)(filePath, "utf8")
    const parsed = JSON.parse(raw) as Record<string, AuthInfo>
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

async function refreshAnthropic(
  info: OAuthInfo,
  deps: Required<Pick<AuthDependencies, "fetchImpl" | "sleep">>,
): Promise<OAuthInfo> {
  const response = await withRetry(
    () =>
      deps
        .fetchImpl("https://console.anthropic.com/v1/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: info.refresh,
            client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
          }),
        })
        .then(async (result) => {
          if (!result.ok) {
            const error = new Error(`HTTP ${result.status}`) as Error & { response?: Response; status?: number }
            error.response = result
            error.status = result.status
            throw error
          }
          return result
        }),
    deps,
  )

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch (error) {
    throw buildOAuthRefreshError("anthropic", normalizeReason(error))
  }

  if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw buildOAuthRefreshError("anthropic", "Invalid token response")
  }

  return {
    type: "oauth",
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
    accountId: info.accountId,
    enterpriseUrl: info.enterpriseUrl,
  }
}

async function refreshOpenAI(
  info: OAuthInfo,
  deps: Required<Pick<AuthDependencies, "fetchImpl" | "sleep">>,
): Promise<OAuthInfo> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: info.refresh,
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    scope: "openid profile email offline_access",
  })
  const response = await withRetry(
    () =>
      deps
        .fetchImpl("https://auth.openai.com/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        })
        .then(async (result) => {
          if (!result.ok) {
            const error = new Error(`HTTP ${result.status}`) as Error & { response?: Response; status?: number }
            error.response = result
            error.status = result.status
            throw error
          }
          return result
        }),
    deps,
  )

  let parsed: Record<string, unknown>
  try {
    parsed = (await response.json()) as Record<string, unknown>
  } catch (error) {
    throw buildOAuthRefreshError("openai", normalizeReason(error))
  }

  if (typeof parsed.access_token !== "string" || typeof parsed.refresh_token !== "string") {
    throw buildOAuthRefreshError("openai", "Invalid token response")
  }

  return {
    type: "oauth",
    access: parsed.access_token,
    refresh: parsed.refresh_token,
    expires: Date.now() + (typeof parsed.expires_in === "number" ? parsed.expires_in : 3600) * 1000,
    accountId: info.accountId,
    enterpriseUrl: info.enterpriseUrl,
  }
}

async function exchangeCopilotToken(
  info: OAuthInfo,
  deps: Required<Pick<AuthDependencies, "fetchImpl" | "sleep">>,
): Promise<{ token: string }> {
  const response = await withRetry(
    () =>
      deps
        .fetchImpl("https://api.github.com/copilot_internal/v2/token", {
          method: "GET",
          headers: {
            Authorization: `token ${info.refresh}`,
          },
        })
        .then(async (result) => {
          if (!result.ok) {
            const error = new Error(`HTTP ${result.status}`) as Error & { response?: Response; status?: number }
            error.response = result
            error.status = result.status
            throw error
          }
          return result
        }),
    deps,
  )

  const parsed = (await response.json()) as Record<string, unknown>
  if (typeof parsed.token !== "string") {
    throw buildOAuthRefreshError("github-copilot", "Invalid token response")
  }
  return { token: parsed.token }
}

export function createCredentialResolver(
  client: PluginClientLike,
  options: ResolvedTranslateOptions,
  deps: AuthDependencies = {},
) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const sleepImpl = deps.sleep ?? ((ms: number) => sleep(ms))

  async function getProvider(providerID: string): Promise<ProviderInfo | undefined> {
    try {
      const listed = unwrapData(await client.provider.list({ throwOnError: true }))
      return listed.all.find((provider) => provider.id === providerID)
    } catch {
      return undefined
    }
  }

  async function resolveOAuth(providerID: string): Promise<OAuthInfo | undefined> {
    const authMap = await readAuthMap(deps)
    const info = ensureOAuthInfo(authMap?.[providerID])
    if (!info) return undefined
    if (info.expires >= now() + 60_000) return info

    const existing = oauthRefreshInflight.get(providerID)
    if (existing) return existing

    const refreshPromise = (async () => {
      try {
        let refreshed: OAuthInfo
        try {
          if (providerID === "anthropic") {
            refreshed = await refreshAnthropic(info, { fetchImpl, sleep: sleepImpl })
          } else if (providerID === "openai") {
            refreshed = await refreshOpenAI(info, { fetchImpl, sleep: sleepImpl })
          } else if (providerID === "github-copilot") {
            return info
          } else {
            return info
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes(":OAUTH_REFRESH_FAILED]")) throw error
          throw buildOAuthRefreshError(providerID, normalizeReason(error))
        }

        await client.auth.set({
          path: { id: providerID },
          body: refreshed,
        })

        return refreshed
      } finally {
        oauthRefreshInflight.delete(providerID)
      }
    })()

    oauthRefreshInflight.set(providerID, refreshPromise)
    return refreshPromise
  }

  function buildOAuthFetch(providerID: string): FetchLike {
    return async (input, init) => {
      const info = await resolveOAuth(providerID)
      if (!info) return fetchImpl(input, init)

      const headers = copyHeaders(init?.headers)
      setUserAgent(headers, deps.packageVersion)
      const inputUrl =
        input instanceof URL ? new URL(input.href) : new URL(typeof input === "string" ? input : input.url)

      if (providerID === "anthropic") {
        headers.set("Authorization", `Bearer ${info.access}`)
        headers.set("anthropic-beta", "oauth-2025-04-20,interleaved-thinking-2025-05-14")
        headers.set("anthropic-version", "2023-06-01")
        headers.delete("x-api-key")
        if (inputUrl.pathname === "/v1/messages" && !inputUrl.searchParams.has("beta")) {
          inputUrl.searchParams.set("beta", "true")
        }
      }

      if (providerID === "openai") {
        headers.set("Authorization", `Bearer ${info.access}`)
        if (info.accountId) headers.set("ChatGPT-Account-Id", info.accountId)
        if (
          inputUrl.hostname === "api.openai.com" &&
          (inputUrl.pathname === "/v1/chat/completions" || inputUrl.pathname === "/v1/responses")
        ) {
          inputUrl.protocol = "https:"
          inputUrl.hostname = "chatgpt.com"
          inputUrl.pathname = "/backend-api/codex/responses"
          inputUrl.search = ""
        }
      }

      if (providerID === "github-copilot") {
        const session = await exchangeCopilotToken(info, { fetchImpl, sleep: sleepImpl })
        headers.set("Authorization", `Bearer ${session.token}`)
        headers.set(
          "Editor-Version",
          deps.packageVersion ? `${USER_AGENT.replace("0.0.0", deps.packageVersion)}` : USER_AGENT,
        )
        headers.set(
          "Editor-Plugin-Version",
          deps.packageVersion ? `${USER_AGENT.replace("0.0.0", deps.packageVersion)}` : USER_AGENT,
        )
        headers.set("Copilot-Integration-Id", "vscode-chat")
        headers.delete("x-api-key")

        if (info.enterpriseUrl) {
          const target = new URL(
            info.enterpriseUrl.includes("://") ? info.enterpriseUrl : `https://${info.enterpriseUrl}`,
          )
          inputUrl.protocol = target.protocol
          inputUrl.hostname = target.hostname
          inputUrl.port = target.port
        }
      }

      return fetchImpl(inputUrl, {
        ...init,
        headers,
      })
    }
  }

  async function resolve(providerModel: string): Promise<ResolvedCredential> {
    const { providerID } = parseTranslatorModel(providerModel)
    const cached = credentialCache.get(providerID)
    if (cached) return cached

    const provider = await getProvider(providerID)

    if (options.apiKey) {
      const resolved = { providerID, provider, apiKey: options.apiKey, mode: "apiKey" as const }
      credentialCache.set(providerID, resolved)
      return resolved
    }

    const providerKey = normalizeProviderKey(provider?.key)

    if (provider?.source === "api" && providerKey) {
      const resolved = { providerID, provider, apiKey: providerKey, mode: "apiKey" as const }
      credentialCache.set(providerID, resolved)
      return resolved
    }

    if (provider?.source === "env" && providerKey) {
      const resolved = { providerID, provider, apiKey: providerKey, mode: "apiKey" as const }
      credentialCache.set(providerID, resolved)
      return resolved
    }

    if (provider?.source === "custom" || provider?.key === OAUTH_DUMMY_KEY) {
      const oauthInfo = await resolveOAuth(providerID)
      if (oauthInfo) {
        const resolved = {
          providerID,
          provider,
          apiKey: "",
          fetch: buildOAuthFetch(providerID),
          mode: "oauth" as const,
        }
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

  function authUnavailable(providerID: string, provider?: ProviderInfo): Error {
    return buildAuthUnavailableError(providerID, getEnvVarHint(provider))
  }

  return {
    resolve,
    authUnavailable,
    isMissingCredentialError,
    envFallback: AUTH_ENV_FALLBACK,
  }
}
