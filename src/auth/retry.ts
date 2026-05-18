import { normalizeReason } from "../constants"
import { headerValue } from "./headers"
import type { AuthDependencies } from "./types"

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
  const response = (error as Record<string, unknown>).response
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

export async function withRetry<T>(
  task: () => Promise<T>,
  deps: Required<Pick<AuthDependencies, "sleep">>,
): Promise<T> {
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
