import { Plugin } from "@opencode/plugin"
import { setup } from "./activation"

export const OpencodeTranslate = Plugin.define({ id: "opencode-translate", setup })

export default OpencodeTranslate
