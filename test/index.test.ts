import { expect, test } from "bun:test"
import plugin, { OpencodeTranslate } from "../src/index"
import { host } from "./helpers"

test("v2 exports the stable definition and honors the disable flag without validating options", async () => {
  expect(plugin).toBe(OpencodeTranslate)
  expect(plugin.id).toBe("opencode-translate")
  const h = host({ model: "" })
  const previous = process.env.OPENCODE_TRANSLATE_DISABLE
  try {
    process.env.OPENCODE_TRANSLATE_DISABLE = "1"
    expect(await plugin.setup(h.ctx)).toBeUndefined()
    expect(h.callbacks.size).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_TRANSLATE_DISABLE
    else process.env.OPENCODE_TRANSLATE_DISABLE = previous
  }
})
