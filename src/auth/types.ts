import type { AuthInfo, FetchLike, OAuthInfo, ProviderInfo } from "../constants"

export interface ResolvedCredential {
  providerID: string
  provider?: ProviderInfo
  authInfo?: AuthInfo
  apiKey?: string
  fetch?: FetchLike
  mode: "apiKey" | "oauth" | "default"
}

export interface AuthDependencies {
  fetchImpl?: FetchLike
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>
  packageVersion?: string
}

export type AuthRuntime = Required<Pick<AuthDependencies, "fetchImpl" | "sleep">>

export type OAuthResolver = (providerID: string) => Promise<OAuthInfo | undefined>

export interface CodexBodyRewrite {
  body: BodyInit | null | undefined
  originalStream: boolean
}
