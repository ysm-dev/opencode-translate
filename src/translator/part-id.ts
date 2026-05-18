import { createHash, randomBytes } from "node:crypto"

const PART_ID_LENGTH = 26
const PART_ID_PREFIX = "prt"
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

let partLastTimestamp = 0
let partCounter = 0

export function __resetSyntheticPartIDForTest() {
  partLastTimestamp = 0
  partCounter = 0
}

function randomBase62(length: number): string {
  const bytes = randomBytes(length)
  let result = ""
  for (let index = 0; index < length; index += 1) {
    result += BASE62_CHARS[bytes[index] % BASE62_CHARS.length]
  }
  return result
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)
}

export function createSyntheticPartID(): string {
  const currentTimestamp = Date.now()
  if (currentTimestamp !== partLastTimestamp) {
    partLastTimestamp = currentTimestamp
    partCounter = 0
  }
  partCounter += 1

  const encoded = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(partCounter)
  const timeBytes = Buffer.alloc(6)
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & BigInt(0xff))
  }

  return `${PART_ID_PREFIX}_${timeBytes.toString("hex")}${randomBase62(PART_ID_LENGTH - 12)}`
}
