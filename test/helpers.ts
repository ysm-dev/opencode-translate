import type { Plugin } from "@opencode/plugin"

export function host(options: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>()
  const callbacks = new Map<string, ((event: unknown) => Promise<void> | void)[]>()
  const history: Record<string, { type: string; metadata?: Record<string, unknown> }[]> = {}
  const children = new Set<string>()
  const forks = new Map<string, string>()
  const requests: { model: unknown; prompt: string }[] = []
  const createdSessions: Record<string, unknown>[] = []
  const sessionRequests: { sessionID: string; prompt: string }[] = []
  const missingSessions = new Set<string>()
  let generate = async (_prompt: string) => "translated"
  let sessionGenerate = async (_prompt: string) => "session-translated"
  const hook = (domain: string) => async (name: string, callback: (event: unknown) => Promise<void> | void) => {
    const key = `${domain}.${name}`
    callbacks.set(key, [...(callbacks.get(key) ?? []), callback])
    return {
      dispose: async () => {
        const remaining = callbacks.get(key)?.filter((item) => item !== callback) ?? []
        if (remaining.length) callbacks.set(key, remaining)
        else callbacks.delete(key)
      },
    }
  }
  const ctx = {
    app: { version: "2.0.3", name: "opencode", channel: "latest" },
    location: {
      directory: "/test/project",
      project: { id: "project_1", directory: "/test/project", canonical: "/test/project" },
    },
    options: { model: "openai/gpt-5.4-mini", lang: "Korean", ...options },
    session: {
      hook: hook("session"),
      get: async ({ sessionID }: { sessionID: string }) => {
        if (missingSessions.has(sessionID))
          return Promise.reject({ _tag: "SessionNotFoundError", message: "Missing session" })
        return {
          id: sessionID,
          parentID: children.has(sessionID) ? "parent" : undefined,
          fork: forks.has(sessionID) ? { sessionID: forks.get(sessionID) } : undefined,
        }
      },
      create: async (input: Record<string, unknown>) => {
        const session = { ...input, id: `ses_helper_${createdSessions.length + 1}` }
        createdSessions.push(session)
        return session
      },
      generate: async (input: { sessionID: string; prompt: string }) => {
        sessionRequests.push(input)
        return { text: await sessionGenerate(input.prompt) }
      },
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
    createdSessions,
    sessionRequests,
    missingSessions,
    generate: (impl: typeof generate) => {
      generate = impl
    },
    sessionGenerate: (impl: typeof sessionGenerate) => {
      sessionGenerate = impl
    },
    async emit(name: string, event: unknown) {
      const registered = callbacks.get(name)
      if (!registered) throw new Error(`Missing hook ${name}`)
      for (const callback of registered) await callback(event)
    },
  }
}

export function prompt(text = "$en 안녕하세요", sessionID = "ses_1") {
  return { sessionID, messageID: "msg_1", prompt: { text }, metadata: {} as Record<string, unknown>, delivery: "steer" }
}

export function requestContext(messages: unknown[], sessionID = "ses_1") {
  return { sessionID, model: { providerID: "openai", id: "gpt-5.4" }, system: [], messages, options: {} }
}
