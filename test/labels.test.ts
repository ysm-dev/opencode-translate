import { describe, expect, test } from "bun:test"
import { getDisplayLanguageLabel } from "../src/labels"

describe("labels", () => {
  test("uses the configured language directly", () => {
    expect(getDisplayLanguageLabel("Korean")).toBe("Translation (Korean)")
    expect(getDisplayLanguageLabel("Brazilian Portuguese")).toBe("Translation (Brazilian Portuguese)")
  })
})
