import type { Plugin, PluginInput, PluginOptions, PluginModule } from "@opencode-ai/plugin"
import { createHooks } from "./activation"
import { writeFileSync } from "node:fs"

const DEBUG_LOG = process.env.OPENCODE_TRANSLATE_DEBUG
  ? (msg: string) => {
      try { writeFileSync(process.env.OPENCODE_TRANSLATE_DEBUG as string, `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch { }
    }
  : () => {}

// Module-level probe: confirms the correct file was loaded
DEBUG_LOG(`MODULE_LOADED`)

const OpencodeTranslate: Plugin = async (ctx: PluginInput, options?: PluginOptions) => {
  DEBUG_LOG(`FUNCTION_CALLED ctx.directory=${ctx.directory}`)
  try {
    const hooks = createHooks(ctx, options ?? {})
    DEBUG_LOG(`HOOKS_REGISTERED keys=${Object.keys(hooks).join(",")}`)
    return hooks
  } catch (e: any) {
    DEBUG_LOG(`INIT_ERROR ${e?.message ?? String(e)}`)
    throw e
  }
}

const pluginModule: PluginModule = {
  id: "opencode-translate",
  server: OpencodeTranslate,
}

export default pluginModule
