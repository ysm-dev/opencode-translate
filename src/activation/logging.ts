import { normalizeReason, PLUGIN_NAME, type PluginClientLike } from "../constants"

export function logError(client: PluginClientLike, error: unknown) {
  return client.app.log({
    body: {
      service: PLUGIN_NAME,
      level: "error",
      message: normalizeReason(error),
    },
  })
}
