import type { PluginClientLike, ProviderInfo } from "../../src/constants"

export function fakeClient(providers: ProviderInfo[], authSetCalls: unknown[] = []): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID: null }),
      messages: async () => [],
      message: async () => ({ info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [] }),
    },
    provider: {
      list: async () => ({ all: providers }),
    },
    auth: {
      set: async (input) => {
        authSetCalls.push(input)
        return undefined
      },
    },
    app: {
      log: async () => undefined,
    },
  }
}
