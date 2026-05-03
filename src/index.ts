import type { Plugin, PluginInput, PluginOptions, PluginModule } from "@opencode-ai/plugin"
import { createHooks } from "./activation"
import { writeFileSync } from "node:fs"

const DEBUG_LOG = process.env.OPENCODE_TRANSLATE_DEBUG
  ? (msg: string) => {
      try { writeFileSync(process.env.OPENCODE_TRANSLATE_DEBUG as string, `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch { }
    }
  : () => {}

const OpencodeTranslate: Plugin = async (ctx: PluginInput, options?: PluginOptions) => {
  DEBUG_LOG("OpencodeTranslate called, creating hooks...")
  try {
    const hooks = createHooks(ctx, options ?? {})
    DEBUG_LOG(`createHooks returned: keys=${Object.keys(hooks).join(",")}`)
    return hooks
  } catch (e: any) {
    DEBUG_LOG(`createHooks threw: ${e?.message ?? String(e)}`)
    throw e
  }
}

const pluginModule: PluginModule = {
  id: "opencode-translate",
  server: OpencodeTranslate,
}

export { pluginModule as server }
export default pluginModule
