import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createHooks } from "./activation"

export const OpencodeTranslate: Plugin = async (ctx: PluginInput, options?: PluginOptions) =>
  createHooks(ctx, options ?? {})

export default OpencodeTranslate
