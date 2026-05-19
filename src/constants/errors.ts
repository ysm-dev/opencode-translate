import { PLUGIN_NAME } from "./plugin"

export function normalizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split(/\r?\n/, 1)[0].trim().slice(0, 200)
}

export function buildInboundTranslationError(userLanguage: string, reason: string): Error {
  return new Error(
    `[${PLUGIN_NAME}:INBOUND_TRANSLATION_FAILED] Failed to translate user message from ${userLanguage} to English: ${reason}`,
  )
}

export function buildAuthUnavailableError(providerID: string, envVar: string): Error {
  return new Error(
    `[${PLUGIN_NAME}:AUTH_UNAVAILABLE] No credential found for provider "${providerID}". Set ${envVar} in the environment or run "opencode auth login ${providerID}".`,
  )
}

export function buildOAuthRefreshError(providerID: string, reason: string): Error {
  return new Error(
    `[${PLUGIN_NAME}:OAUTH_REFRESH_FAILED] Failed to refresh OAuth token for provider "${providerID}": ${reason}. Re-authenticate with "opencode auth login ${providerID}".`,
  )
}
