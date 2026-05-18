import { afterEach, expect, test } from "bun:test"
import OpencodeTranslate, { OpencodeTranslate as namedPlugin } from "../src/index"

afterEach(() => {
  delete process.env.OPENCODE_TRANSLATE_DISABLE
})

test("default export and named plugin share the same implementation", async () => {
  process.env.OPENCODE_TRANSLATE_DISABLE = "1"
  const ctx = {
    client: {},
    directory: "/workspace",
  }

  expect(OpencodeTranslate).toBe(namedPlugin)
  expect(await OpencodeTranslate(ctx as never, {})).toEqual({})
})
