import type { Plugin } from "@opencode/plugin"

interface ProviderEditor {
  list(): readonly { readonly provider: { readonly id: string; readonly settings?: Record<string, unknown> } }[]
  update(providerID: string, update: (provider: { settings?: Record<string, unknown> }) => void): void
}

interface ProviderDomain {
  transform(callback: (editor: ProviderEditor) => void): Promise<unknown>
}

// Replies are translated in the `http.response` hook. OpenCode 2.0.3 routed
// sessions over HTTP whenever HTTP hooks were registered; later releases stream
// WebSocket-default providers (OpenAI, xAI) over a session socket regardless, so
// their replies never reach the hook. The provider domain replaced 2.0.3's catalog.
export async function requireHttpTransport(ctx: Plugin.Context) {
  const provider = "provider" in ctx ? (ctx.provider as ProviderDomain | undefined) : undefined
  if (!provider) return
  await provider.transform((editor) => {
    for (const { provider: info } of editor.list()) {
      if (info.settings?.transport !== "websocket") continue
      editor.update(info.id, (draft) => {
        draft.settings = { ...draft.settings, transport: "http" }
      })
    }
  })
}
