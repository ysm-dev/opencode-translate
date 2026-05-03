import type { Plugin, PluginInput, PluginOptions, PluginModule } from "@opencode-ai/plugin"
import { createHooks } from "./activation"
import { writeFileSync } from "node:fs"

const log = (msg: string) => {
  try { writeFileSync("C:\\Users\\sxlon\\AppData\\Local\\Temp\\opencode-translate-debug.log", `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch { }
}

log("MODULE_LOADED")

const OpencodeTranslate: Plugin = async (ctx: PluginInput, options?: PluginOptions) => {
  log(`FUNCTION_CALLED dir=${ctx.directory}`)
  try {
    const hooks = createHooks(ctx, options ?? {})
    log(`HOOKS keys=${Object.keys(hooks).join(",")}`)
    return hooks
  } catch (e: any) {
    log(`INIT_ERR ${e?.message ?? String(e)}`)
    throw e
  }
}

const pluginModule: PluginModule = {
  id: "opencode-translate",
  server: OpencodeTranslate,
}

export default pluginModule
