import { describe, expect, test } from "bun:test"
import {
  buildBillingHeaderValue,
  buildOAuthSystem,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_CODE_IDENTITY,
  isAnthropicMessagesRequest,
  mergeBetaHeaders,
  rewriteMessagesBody,
  rewriteMessagesURL,
  setOAuthHeaders,
} from "../src/anthropic-oauth"

describe("anthropic-oauth", () => {
  test("setOAuthHeaders writes the claude-cli fingerprint and drops x-api-key", () => {
    const headers = new Headers({ "x-api-key": "leftover" })
    setOAuthHeaders(headers, "sk-test-access")
    expect(headers.get("authorization")).toBe("Bearer sk-test-access")
    expect(headers.get("user-agent")).toBe(CLAUDE_CLI_USER_AGENT)
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(headers.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14")
  })

  test("mergeBetaHeaders preserves incoming betas and deduplicates", () => {
    const headers = new Headers({ "anthropic-beta": "oauth-2025-04-20, extra-beta" })
    const merged = mergeBetaHeaders(headers)
    const values = merged.split(",").map((value) => value.trim())
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain("oauth-2025-04-20")
    expect(values).toContain("interleaved-thinking-2025-05-14")
    expect(values).toContain("extra-beta")
  })

  test("rewriteMessagesURL adds beta=true on /v1/messages but not elsewhere", () => {
    const messages = new URL("https://api.anthropic.com/v1/messages")
    rewriteMessagesURL(messages)
    expect(messages.searchParams.get("beta")).toBe("true")

    const other = new URL("https://api.anthropic.com/v1/models")
    rewriteMessagesURL(other)
    expect(other.searchParams.get("beta")).toBeNull()
  })

  test("isAnthropicMessagesRequest matches only /v1/messages", () => {
    expect(isAnthropicMessagesRequest(new URL("https://api.anthropic.com/v1/messages"))).toBe(true)
    expect(isAnthropicMessagesRequest(new URL("https://api.anthropic.com/v1/messages?beta=true"))).toBe(true)
    expect(isAnthropicMessagesRequest(new URL("https://api.anthropic.com/v1/models"))).toBe(false)
  })

  test("buildOAuthSystem injects billing header, identity, then existing blocks", () => {
    const messages = [{ role: "user", content: "Translate: 안녕하세요" }]
    const system = buildOAuthSystem("Original translator prompt", messages)
    expect(system[0].text.startsWith("x-anthropic-billing-header:")).toBe(true)
    expect(system[0].text).toContain("cc_entrypoint=sdk-cli")
    expect(system[0].text).toContain("cch=")
    expect(system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(system[2].text).toBe("Original translator prompt")
  })

  test("buildOAuthSystem deduplicates an existing Claude Code identity block", () => {
    const messages = [{ role: "user", content: "Hello" }]
    const system = buildOAuthSystem(
      [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        { type: "text", text: "translator prompt" },
      ],
      messages,
    )
    const identityCount = system.filter((block) => block.text === CLAUDE_CODE_IDENTITY).length
    expect(identityCount).toBe(1)
    expect(system.at(-1)?.text).toBe("translator prompt")
  })

  test("buildBillingHeaderValue is deterministic for the same first user message", () => {
    const messages = [{ role: "user", content: "Translate: 안녕" }]
    const a = buildBillingHeaderValue(messages)
    const b = buildBillingHeaderValue(messages)
    expect(a).toBe(b)
    expect(a).toContain("cc_entrypoint=sdk-cli")
    expect(a).toContain("cch=")
  })

  test("rewriteMessagesBody rewrites system[] and preserves model/messages", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 128,
      system: "translator prompt",
      messages: [{ role: "user", content: "Translate: 안녕" }],
    })
    const parsed = JSON.parse(rewriteMessagesBody(body)) as {
      model: string
      max_tokens: number
      system: Array<{ type: string; text: string }>
      messages: unknown[]
    }

    expect(parsed.model).toBe("claude-opus-4-7")
    expect(parsed.max_tokens).toBe(128)
    expect(Array.isArray(parsed.system)).toBe(true)
    expect(parsed.system[0].text.startsWith("x-anthropic-billing-header:")).toBe(true)
    expect(parsed.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(parsed.system[2].text).toBe("translator prompt")
    expect(parsed.messages).toHaveLength(1)
  })

  test("rewriteMessagesBody returns the original string if JSON parsing fails", () => {
    expect(rewriteMessagesBody("not json")).toBe("not json")
  })
})
