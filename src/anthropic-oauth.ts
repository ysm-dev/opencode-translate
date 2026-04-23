// Anthropic OAuth request transformations.
//
// When using Anthropic's OAuth credentials (Claude Pro/Max) outside of the
// official Claude Code client, the /v1/messages API responds with a
// `429 rate_limit_error` and an empty "Error" message unless the request
// shape matches the Claude Code CLI fingerprint: specific headers, a
// `?beta=true` query, the Claude Code identity in `system[0]`, and a
// deterministic billing header block.
//
// This module implements the minimum transformation that makes translator
// requests pass those checks. The technique (including the identity string,
// required beta headers, and CCH billing header format) is documented by the
// `@ex-machina/opencode-anthropic-auth` plugin:
//
//   https://github.com/ex-machina-co/opencode-anthropic-auth
//
// We only apply these transformations to translator requests this plugin
// originates. OpenCode's main chat already has its own auth loader (e.g.
// `@ex-machina/opencode-anthropic-auth`) handling its requests independently.

import { createHash } from "node:crypto"

export const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"] as const

export const CLAUDE_CODE_VERSION = "2.1.87"
export const CLAUDE_CODE_ENTRYPOINT = "sdk-cli"
export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`

// Deterministic billing header parameters — must match Claude Code's own derivation.
const CCH_SALT = "59cf53e54c78"
const CCH_POSITIONS = [4, 7, 20] as const

type SystemBlock = { type: string; text: string; [key: string]: unknown }

type MessageLike = {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function extractFirstUserMessageText(messages: MessageLike[] | undefined): string {
  if (!Array.isArray(messages)) return ""
  const first = messages.find((message) => message?.role === "user")
  if (!first) return ""
  const { content } = first
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block?.type === "text")
    if (textBlock?.text) return textBlock.text
  }
  return ""
}

function computeCCH(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5)
}

function computeVersionSuffix(messageText: string, version: string): string {
  const chars = CCH_POSITIONS.map((index) => messageText[index] ?? "0").join("")
  return createHash("sha256").update(`${CCH_SALT}${chars}${version}`).digest("hex").slice(0, 3)
}

export function buildBillingHeaderValue(messages: MessageLike[] | undefined): string {
  const text = extractFirstUserMessageText(messages)
  const cch = computeCCH(text)
  const suffix = computeVersionSuffix(text, CLAUDE_CODE_VERSION)
  return (
    "x-anthropic-billing-header: " +
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; ` +
    `cch=${cch};`
  )
}

export function mergeBetaHeaders(headers: Headers): string {
  const incoming = headers.get("anthropic-beta") || ""
  const incomingList = incoming
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...REQUIRED_BETAS, ...incomingList])].join(",")
}

export function setOAuthHeaders(headers: Headers, accessToken: string): Headers {
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-beta", mergeBetaHeaders(headers))
  headers.set("user-agent", CLAUDE_CLI_USER_AGENT)
  headers.delete("x-api-key")
  return headers
}

export function rewriteMessagesURL(input: URL): URL {
  if (input.pathname === "/v1/messages" && !input.searchParams.has("beta")) {
    input.searchParams.set("beta", "true")
  }
  return input
}

function normalizeSystem(raw: unknown): SystemBlock[] {
  if (raw == null) return []
  if (typeof raw === "string") return raw.length > 0 ? [{ type: "text", text: raw }] : []
  if (isRecord(raw)) {
    const type = typeof raw.type === "string" ? raw.type : "text"
    const text = typeof raw.text === "string" ? raw.text : ""
    return [{ ...raw, type, text }]
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map((item): SystemBlock | null => {
      if (typeof item === "string") return { type: "text", text: item }
      if (isRecord(item) && typeof item.text === "string") {
        const type = typeof item.type === "string" ? item.type : "text"
        return { ...item, type, text: item.text }
      }
      return null
    })
    .filter((block): block is SystemBlock => block !== null)
}

export function buildOAuthSystem(rawSystem: unknown, messages: MessageLike[] | undefined): SystemBlock[] {
  const identity: SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY }
  const existing = normalizeSystem(rawSystem).filter((block) => block.text !== CLAUDE_CODE_IDENTITY)
  const billing: SystemBlock = { type: "text", text: buildBillingHeaderValue(messages) }
  return [billing, identity, ...existing]
}

// Rewrite an /v1/messages POST body so its system prompt and billing header
// satisfy Claude Code's OAuth fingerprint. Returns the original body on parse
// failure so we never break a request that was already well-formed.
export function rewriteMessagesBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const messages = Array.isArray(parsed.messages) ? (parsed.messages as MessageLike[]) : undefined
    parsed.system = buildOAuthSystem(parsed.system, messages)
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

export function isAnthropicMessagesRequest(url: URL): boolean {
  return url.pathname === "/v1/messages"
}
