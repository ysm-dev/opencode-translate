import type { MessageWithPartsLike, PluginClientLike, TextPartLike } from "../../src/constants"
import { hashText } from "../../src/translator"

export function textPart(id: string, text: string, extra: Partial<TextPartLike> = {}): TextPartLike {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text,
    ...extra,
  }
}

export function activeStateMetadata(text: string) {
  return {
    translate_enabled: true,
    translate_user_lang: "Korean",
    translate_llm_lang: "English",
    translate_nonce: "0123456789abcdef0123456789abcdef",
    translate_source_hash: hashText(text),
    translate_en: `EN:${text}`,
  }
}

export function fakeClient(messages: MessageWithPartsLike[]): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID: null }),
      messages: async () => messages,
      message: async () => messages[0],
    },
    provider: {
      list: async () => ({ all: [] }),
    },
    auth: {
      set: async () => undefined,
    },
    app: {
      log: async () => undefined,
    },
  }
}

export function encodeAscendingPartIDForTest(timestamp: number, counter: number): string {
  const encoded = BigInt(timestamp) * BigInt(0x1000) + BigInt(counter)
  const bytes = Buffer.alloc(6)
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & BigInt(0xff))
  }
  return `prt_${bytes.toString("hex")}00000000000000`
}
