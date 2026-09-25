import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { setup } from "../src/activation"
import { requireHttpTransport } from "../src/transport"
import { host } from "./helpers"

function providerDomain(settings: Record<string, Record<string, unknown> | undefined>) {
  const providers = new Map(Object.entries(settings).map(([id, value]) => [id, { id, settings: value }]))
  const updated: string[] = []
  const transforms: unknown[] = []
  const domain = {
    transform: async (callback: (editor: unknown) => void) => {
      transforms.push(callback)
      callback({
        list: () => [...providers.values()].map((provider) => ({ provider })),
        update: (id: string, update: (provider: { settings?: Record<string, unknown> }) => void) => {
          updated.push(id)
          const provider = providers.get(id)
          if (provider) update(provider)
        },
      })
      return { dispose: async () => {} }
    },
  }
  return { domain, providers, updated, transforms }
}

test("WebSocket-default providers are routed over HTTP so replies reach the http.response hook", async () => {
  const p = providerDomain({
    openai: { transport: "websocket", baseURL: "https://chatgpt.com/backend-api/codex" },
    xai: { transport: "websocket" },
    anthropic: { baseURL: "https://api.anthropic.com/v1" },
    explicit: { transport: "http" },
    bare: undefined,
  })
  await requireHttpTransport({ provider: p.domain } as unknown as Plugin.Context)
  expect(p.updated).toEqual(["openai", "xai"])
  expect(p.providers.get("openai")?.settings).toEqual({
    transport: "http",
    baseURL: "https://chatgpt.com/backend-api/codex",
  })
  expect(p.providers.get("xai")?.settings).toEqual({ transport: "http" })
  expect(p.providers.get("anthropic")?.settings).toEqual({ baseURL: "https://api.anthropic.com/v1" })
})

test("2.0.3 hosts, which expose no provider domain and already use HTTP, are left alone", async () => {
  await requireHttpTransport(host().ctx)
})

test("setup registers the transport requirement on hosts with a provider domain", async () => {
  const h = host()
  const p = providerDomain({ openai: { transport: "websocket" } })
  Object.assign(h.ctx, { provider: p.domain })
  const cleanup = await setup(h.ctx)
  expect(p.transforms).toHaveLength(1)
  expect(p.providers.get("openai")?.settings).toEqual({ transport: "http" })
  cleanup?.()
})
