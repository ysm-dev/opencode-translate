import { beforeEach, describe, expect, test } from "bun:test"
import { __resetActivationCacheForTest, createHooks } from "../../src/activation"
import type { TextPartLike } from "../../src/constants"
import { fakeClient, filePart, textPart } from "./helpers"

describe("activation part ordering", () => {
  beforeEach(() => {
    __resetActivationCacheForTest()
  })

  test("multi-part ordering stays exact on activation turn", async () => {
    const hooks = createHooks(
      { client: fakeClient([]), directory: "/workspace" } as never,
      { lang: "Korean", model: "anthropic/claude-haiku-4-5" },
      { translator: { translateText: async ({ text }) => `EN:${text}` } },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [textPart("p1", "$en 첫번째"), filePart(), textPart("p2", "두번째")],
    }
    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)

    expect(output.parts).toHaveLength(6)
    expect((output.parts[0] as TextPartLike).text).toContain("첫번째\n\n→ EN: EN:첫번째")
    expect((output.parts[0] as TextPartLike).text).toContain("✓ Translation mode enabled")
    expect((output.parts[1] as TextPartLike).text).toBe("EN:첫번째")
    expect((output.parts[1] as TextPartLike).metadata?.translate_role).toBe("llm_only_translation")
    expect((output.parts[2] as TextPartLike).type).toBe("file")
    expect((output.parts[3] as TextPartLike).text).toBe("두번째\n\n→ EN: EN:두번째")
    expect((output.parts[4] as TextPartLike).text).toBe("EN:두번째")
    expect((output.parts[5] as TextPartLike).metadata?.translate_role).toBe("activation_banner")
    expect((output.parts[1] as TextPartLike).metadata?.translate_part_index).toBe(0)
    expect((output.parts[4] as TextPartLike).metadata?.translate_part_index).toBe(1)
  })

  test("synthetic user parts are skipped during inbound translation", async () => {
    let calls = 0
    const hooks = createHooks(
      { client: fakeClient([]), directory: "/workspace" } as never,
      { model: "anthropic/claude-haiku-4-5", lang: "Korean" },
      {
        translator: {
          translateText: async ({ text }) => {
            calls += 1
            return `EN:${text}`
          },
        },
      },
    )

    const output = {
      message: { id: "msg_new" },
      parts: [
        textPart("p1", "$en 첫번째"),
        textPart("p2", "compaction marker", {
          synthetic: true,
          ignored: true,
          metadata: { compaction_continue: true },
        }),
        textPart("p3", "두번째"),
      ],
    }

    await hooks["chat.message"]!({ sessionID: "ses_1" }, output as never)
    expect(calls).toBe(2)
    expect((output.parts[2] as TextPartLike).text).toBe("compaction marker")
    expect((output.parts[2] as TextPartLike).synthetic).toBe(true)
  })
})
