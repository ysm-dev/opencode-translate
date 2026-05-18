import { USER_AGENT } from "../constants"

export function copyHeaders(headers?: HeadersInit): Headers {
  return new Headers(headers)
}

export function headerValue(headers: Headers, key: string): string | undefined {
  const value = headers.get(key)
  return value === null ? undefined : value
}

export function packageUserAgent(packageVersion?: string): string {
  return packageVersion ? USER_AGENT.replace("0.0.0", packageVersion) : USER_AGENT
}

export function setUserAgent(headers: Headers, packageVersion?: string) {
  headers.set("User-Agent", packageUserAgent(packageVersion))
}
