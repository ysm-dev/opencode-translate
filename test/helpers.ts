import type { Plugin } from "@opencode/plugin"

export function host(options: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>()
  const callbacks = new Map<string, (event: unknown) => Promise<void>>()
  const history: Record<string, { type: string; metadata?: Record<string, unknown> }[]> = {}
  const children = new Set<string>()
  const forks = new Map<string, string>()
  const requests: { model: unknown; prompt: string }[] = []
  let generate = async (_prompt: string) => "translated"
  const hook = (domain: string) => async (name: string, callback: (event: unknown) => Promise<void>) => {
    callbacks.set(`${domain}.${name}`, callback)
    return {
      dispose: async () => {
        callbacks.delete(`${domain}.${name}`)
      },
    }
  }
  const ctx = {
    app: { version: "2.0.3" },
    options: { model: "openai/gpt-5.4-mini", lang: "Korean", ...options },
    session: {
      hook: hook("session"),
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: children.has(sessionID) ? "parent" : undefined,
        fork: forks.has(sessionID) ? { sessionID: forks.get(sessionID) } : undefined,
      }),
      context: async ({ sessionID }: { sessionID: string }) => history[sessionID] ?? [],
    },
    tool: { hook: hook("tool") },
    storage: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value))
      },
      remove: async (key: string) => {
        values.delete(key)
      },
      scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
        const all = [...values]
          .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
          .sort(([a], [b]) => a.localeCompare(b))
        const entries = all.slice(0, limit).map(([key, value]) => ({ key, value }))
        return { entries, next: all.length > limit ? entries.at(-1)?.key : undefined }
      },
    },
    generate: {
      text: async (input: { model: unknown; prompt: string }) => {
        requests.push(input)
        return { text: await generate(input.prompt) }
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    values,
    callbacks,
    children,
    forks,
    history,
    requests,
    generate: (impl: typeof generate) => {
      generate = impl
    },
    async emit(name: string, event: unknown) {
      const callback = callbacks.get(name)
      if (!callback) throw new Error(`Missing hook ${name}`)
      await callback(event)
    },
  }
}

export function prompt(text = "$en 안녕하세요", sessionID = "ses_1") {
  return { sessionID, messageID: "msg_1", prompt: { text }, metadata: {} as Record<string, unknown>, delivery: "steer" }
}

export function requestContext(messages: unknown[], sessionID = "ses_1") {
  return { sessionID, model: { providerID: "openai", id: "gpt-5.4" }, system: [], messages, options: {} }
}
