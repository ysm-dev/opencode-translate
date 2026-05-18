import { beforeEach, describe, expect, test } from "bun:test"
import {
  __resetSyntheticPartIDForTest,
  __resetTranslatorCachesForTest,
  createSyntheticPartID,
} from "../../src/translator"
import { encodeAscendingPartIDForTest } from "./helpers"

describe("translator synthetic part ids", () => {
  beforeEach(() => {
    __resetTranslatorCachesForTest()
  })

  test("synthetic part ids use opencode's ascending part-id shape", () => {
    const id = createSyntheticPartID()
    const body = id.slice("prt_".length)

    expect(id.startsWith("prt_")).toBe(true)
    expect(body).toHaveLength(26)
    expect(body.slice(0, 12)).toMatch(/^[0-9a-f]{12}$/)
    expect(body.slice(12)).toMatch(/^[0-9A-Za-z]{14}$/)
  })

  test("synthetic part ids are lexicographically ascending within one millisecond", () => {
    const realDateNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      __resetSyntheticPartIDForTest()
      const ids = Array.from({ length: 32 }, () => createSyntheticPartID())
      expect(ids).toEqual([...ids].sort())
    } finally {
      Date.now = realDateNow
    }
  })

  test("synthetic part ids sort after prior timestamp-based user part ids", () => {
    const realDateNow = Date.now
    const userTimestamp = 1_700_000_000_000
    const userPartID = encodeAscendingPartIDForTest(userTimestamp, 1)
    Date.now = () => userTimestamp + 1
    try {
      __resetSyntheticPartIDForTest()
      expect(createSyntheticPartID() > userPartID).toBe(true)
    } finally {
      Date.now = realDateNow
    }
  })
})
