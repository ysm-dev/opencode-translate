import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type AuthInfo, OAUTH_DUMMY_KEY, type OAuthInfo } from "../constants"
import type { AuthDependencies } from "./types"

// Mirrors opencode's xdg-basedir data location; see packages/core/src/global.ts.
function dataHome(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome) return xdgDataHome
  return path.join(os.homedir(), ".local", "share")
}

function authFilePaths(): string[] {
  const root = path.join(dataHome(), "opencode")
  return [path.join(root, "auth.json"), path.join(root, "auth-v2.json")]
}

export function normalizeProviderKey(value: string | undefined): string | undefined {
  if (!value || value === OAUTH_DUMMY_KEY) return undefined
  return value
}

export function ensureOAuthInfo(value: AuthInfo | undefined): OAuthInfo | undefined {
  return value && value.type === "oauth" ? value : undefined
}

function isAuthInfo(value: unknown): value is AuthInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.type === "api") return typeof record.key === "string"
  if (record.type === "oauth") {
    return typeof record.access === "string" && typeof record.refresh === "string" && typeof record.expires === "number"
  }
  if (record.type === "wellknown") return typeof record.key === "string" && typeof record.token === "string"
  return false
}

function normalizeAuthMap(raw: unknown): Record<string, AuthInfo> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>

  if (
    record.version === 2 &&
    record.accounts &&
    typeof record.accounts === "object" &&
    !Array.isArray(record.accounts)
  ) {
    const accounts = record.accounts as Record<string, unknown>
    const active =
      record.active && typeof record.active === "object" && !Array.isArray(record.active) ? record.active : {}
    const result: Record<string, AuthInfo> = {}

    for (const [serviceID, accountID] of Object.entries(active as Record<string, unknown>)) {
      if (typeof accountID !== "string") continue
      const account = accounts[accountID]
      if (!account || typeof account !== "object" || Array.isArray(account)) continue
      const credential = (account as Record<string, unknown>).credential
      if (isAuthInfo(credential)) result[serviceID] = credential
    }

    for (const account of Object.values(accounts)) {
      if (!account || typeof account !== "object" || Array.isArray(account)) continue
      const accountRecord = account as Record<string, unknown>
      const serviceID = accountRecord.serviceID
      const credential = accountRecord.credential
      if (typeof serviceID === "string" && result[serviceID] === undefined && isAuthInfo(credential)) {
        result[serviceID] = credential
      }
    }

    return result
  }

  const result: Record<string, AuthInfo> = {}
  for (const [providerID, info] of Object.entries(record)) {
    if (isAuthInfo(info)) result[providerID] = info
  }
  return result
}

export async function readAuthMap(deps: AuthDependencies): Promise<Record<string, AuthInfo> | undefined> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      return normalizeAuthMap(JSON.parse(process.env.OPENCODE_AUTH_CONTENT))
    } catch {}
    return undefined
  }

  for (const filePath of authFilePaths()) {
    try {
      const raw = await (deps.readFile ?? readFile)(filePath, "utf8")
      const parsed = normalizeAuthMap(JSON.parse(raw))
      if (parsed) return parsed
    } catch {}
  }
  return undefined
}
