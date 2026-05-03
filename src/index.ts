import type { Plugin, PluginInput, PluginOptions, PluginModule } from "@opencode-ai/plugin"
import { createHooks } from "./activation"

const OpencodeTranslate: Plugin = async (ctx: PluginInput, options?: PluginOptions) =>
  createHooks(ctx, options ?? {})

const pluginModule: PluginModule = {
  id: "opencode-translate",
  server: OpencodeTranslate,
}

export default pluginModule
