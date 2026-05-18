import { buildOAuthRefreshError, normalizeReason, type OAuthInfo } from "../constants"
import { withRetry } from "./retry"
import type { AuthRuntime } from "./types"

async function postOAuthToken(url: string, init: RequestInit, deps: AuthRuntime): Promise<Response> {
  return withRetry(
    () =>
      deps.fetchImpl(url, init).then(async (result) => {
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
}

export async function refreshAnthropic(info: OAuthInfo, deps: AuthRuntime): Promise<OAuthInfo> {
  const response = await postOAuthToken(
    "https://console.anthropic.com/v1/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: info.refresh,
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      }),
    },
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

export async function refreshOpenAI(info: OAuthInfo, deps: AuthRuntime): Promise<OAuthInfo> {
  const response = await postOAuthToken(
    "https://auth.openai.com/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: info.refresh,
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      }),
    },
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

export async function exchangeCopilotToken(info: OAuthInfo, deps: AuthRuntime): Promise<{ token: string }> {
  const response = await postOAuthToken(
    "https://api.github.com/copilot_internal/v2/token",
    { method: "GET", headers: { Authorization: `token ${info.refresh}` } },
    deps,
  )
  const parsed = (await response.json()) as Record<string, unknown>
  if (typeof parsed.token !== "string") throw buildOAuthRefreshError("github-copilot", "Invalid token response")
  return { token: parsed.token }
}
