import {
  isAnthropicMessagesRequest,
  rewriteMessagesBody,
  rewriteMessagesURL,
  setOAuthHeaders as setAnthropicOAuthHeaders,
} from "../anthropic-oauth"
import type { FetchLike, OAuthInfo } from "../constants"
import { rewriteOpenAICodexBody } from "./codex-request"
import { convertCodexSSEToJSON } from "./codex-response"
import { copyHeaders, packageUserAgent, setUserAgent } from "./headers"
import { exchangeCopilotToken } from "./refresh"
import type { AuthRuntime, OAuthResolver } from "./types"

interface OAuthFetchOptions extends AuthRuntime {
  providerID: string
  resolveOAuth: OAuthResolver
  packageVersion?: string
}

interface RequestState {
  headers: Headers
  inputUrl: URL
  body: BodyInit | null | undefined
  convertCodexResponse: boolean
}

function applyAnthropicRequest(state: RequestState, info: OAuthInfo) {
  setAnthropicOAuthHeaders(state.headers, info.access)
  state.headers.set("anthropic-version", "2023-06-01")
  rewriteMessagesURL(state.inputUrl)
  if (isAnthropicMessagesRequest(state.inputUrl) && typeof state.body === "string") {
    state.body = rewriteMessagesBody(state.body)
  }
}

function applyOpenAIRequest(state: RequestState, info: OAuthInfo) {
  state.headers.set("Authorization", `Bearer ${info.access}`)
  if (info.accountId) state.headers.set("ChatGPT-Account-Id", info.accountId)
  if (
    state.inputUrl.hostname !== "api.openai.com" ||
    (state.inputUrl.pathname !== "/v1/chat/completions" && state.inputUrl.pathname !== "/v1/responses")
  ) {
    return
  }

  const rewritten = rewriteOpenAICodexBody(state.body)
  state.inputUrl.protocol = "https:"
  state.inputUrl.hostname = "chatgpt.com"
  state.inputUrl.pathname = "/backend-api/codex/responses"
  state.inputUrl.search = ""
  state.body = rewritten.body
  state.convertCodexResponse = !rewritten.originalStream
  state.headers.set("OpenAI-Beta", "responses=experimental")
  state.headers.set("originator", "codex_cli_rs")
  state.headers.set("accept", "text/event-stream")
  state.headers.delete("content-length")
}

async function applyCopilotRequest(state: RequestState, info: OAuthInfo, options: OAuthFetchOptions) {
  const session = await exchangeCopilotToken(info, options)
  state.headers.set("Authorization", `Bearer ${session.token}`)
  state.headers.set("Editor-Version", packageUserAgent(options.packageVersion))
  state.headers.set("Editor-Plugin-Version", packageUserAgent(options.packageVersion))
  state.headers.set("Copilot-Integration-Id", "vscode-chat")
  state.headers.delete("x-api-key")

  if (info.enterpriseUrl) {
    const target = new URL(info.enterpriseUrl.includes("://") ? info.enterpriseUrl : `https://${info.enterpriseUrl}`)
    state.inputUrl.protocol = target.protocol
    state.inputUrl.hostname = target.hostname
    state.inputUrl.port = target.port
  }
}

function inputToURL(input: RequestInfo | URL): URL {
  return input instanceof URL ? new URL(input.href) : new URL(typeof input === "string" ? input : input.url)
}

export function buildOAuthFetch(options: OAuthFetchOptions): FetchLike {
  return async (input, init) => {
    const info = await options.resolveOAuth(options.providerID)
    if (!info) return options.fetchImpl(input, init)

    const state: RequestState = {
      headers: copyHeaders(init?.headers),
      inputUrl: inputToURL(input),
      body: init?.body,
      convertCodexResponse: false,
    }
    setUserAgent(state.headers, options.packageVersion)

    if (options.providerID === "anthropic") applyAnthropicRequest(state, info)
    if (options.providerID === "openai") applyOpenAIRequest(state, info)
    if (options.providerID === "github-copilot") await applyCopilotRequest(state, info, options)

    const response = await options.fetchImpl(state.inputUrl, { ...init, headers: state.headers, body: state.body })
    if (state.convertCodexResponse && response.ok) return convertCodexSSEToJSON(response)
    return response
  }
}
