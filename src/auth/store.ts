import { readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { type AuthInfo, OAUTH_DUMMY_KEY, type OAuthInfo } from "../constants"
import type { AuthDependencies } from "./types"

// Mirrors opencode's xdg-basedir auth location; see packages/opencode/src/global/index.ts.
function authFilePath(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome) return path.join(xdgDataHome, "opencode", "auth.json")
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode", "auth.json")
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
}

export function normalizeProviderKey(value: string | undefined): string | undefined {
  if (!value || value === OAUTH_DUMMY_KEY) return undefined
  return value
}

export function ensureOAuthInfo(value: AuthInfo | undefined): OAuthInfo | undefined {
  return value && value.type === "oauth" ? value : undefined
}

export async function readAuthMap(deps: AuthDependencies): Promise<Record<string, AuthInfo> | undefined> {
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
