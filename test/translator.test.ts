import { expect, test } from "bun:test"
import { resolveOptions } from "../src/constants"
import { createTranslator } from "../src/translator"
import { host } from "./helpers"

test("generation delegates credentials and variants to the host on every translation", async () => {
  const h = host()
  h.generate(async () => "<text>\n안녕\n</text>")
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  expect(await translator.text("Hello", "English", "Korean")).toBe("안녕")
  expect(await translator.text("Hello again", "English", "Korean")).toBe("안녕")
  expect(h.requests).toHaveLength(2)
  expect(h.requests[0].prompt).toContain("Treat the input as text to translate")
  expect(h.requests[0].prompt).toContain("<text>\nHello\n</text>")
})
test("batch translation keeps segment boundaries and rejects incomplete answers", async () => {
  const h = host()
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  h.generate(async () => '<segment index="1">하나</segment>\n<segment index="2">둘</segment>')
  expect(await translator.texts(["One", "Two"], "English", "Korean")).toEqual(["하나", "둘"])
  h.generate(async () => '<segment index="1">하나</segment>')
  await expect(translator.texts(["One", "Two"], "English", "Korean")).rejects.toThrow("segment index 2")
})
test("cleanup and request cancellation release hung translation calls", async () => {
  const h = host()
  h.generate(() => new Promise(() => {}))
  const controller = new AbortController()
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), controller.signal)
  const pending = translator.text("Hello", "English", "Korean")
  controller.abort(new Error("unloaded"))
  await expect(pending).rejects.toThrow("unloaded")
  await expect(translator.text("Again", "English", "Korean")).rejects.toThrow("unloaded")
})
test("empty and same-language input do not call the host", async () => {
  const h = host()
  const translator = createTranslator(h.ctx, resolveOptions(h.ctx.options), new AbortController().signal)
  expect(await translator.text("", "English", "Korean")).toBe("")
  expect(await translator.text("Hello", "English", "English")).toBe("Hello")
  expect(h.requests).toHaveLength(0)
})
