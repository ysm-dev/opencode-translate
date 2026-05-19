import type { MessageWithPartsLike, PluginClientLike, TextPartLike, TranslateState } from "../../src/constants"

export function textPart(id: string, text: string, extra: Partial<TextPartLike> = {}): TextPartLike {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_new",
    type: "text",
    text,
    ...extra,
  }
}

export function filePart(id = "file_1"): TextPartLike {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_new",
    type: "file",
  }
}

export function makeState(): TranslateState {
  return {
    translate_enabled: true,
    translate_user_lang: "Korean",
    translate_llm_lang: "English",
    translate_nonce: "0123456789abcdef0123456789abcdef",
  }
}

export function storedMessage(parts: TextPartLike[], role = "user"): MessageWithPartsLike {
  return {
    info: {
      id: `msg_${role}`,
      sessionID: "ses_1",
      role,
    },
    parts,
  }
}

export function fakeClient(storedMessages: MessageWithPartsLike[], parentID: string | null = null): PluginClientLike {
  return {
    session: {
      get: async () => ({ id: "ses_1", parentID }),
      messages: async () => storedMessages,
      message: async (input) => {
        const messageID = "messageID" in input ? input.messageID : input.path.messageID
        return storedMessages.find((message) => message.info.id === messageID) ?? storedMessages[0]
      },
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

export function countingClient(
  storedMessages: MessageWithPartsLike[],
  parentID: string | null = null,
  messageResult?: MessageWithPartsLike,
): { client: PluginClientLike; calls: { get: number; messages: number; message: number } } {
  const calls = { get: 0, messages: 0, message: 0 }
  const client: PluginClientLike = {
    session: {
      get: async () => {
        calls.get += 1
        return { id: "ses_1", parentID }
      },
      messages: async () => {
        calls.messages += 1
        return storedMessages
      },
      message: async (input) => {
        calls.message += 1
        const messageID = "messageID" in input ? input.messageID : input.path.messageID
        return messageResult ?? storedMessages.find((message) => message.info.id === messageID) ?? storedMessages[0]
      },
    },
    provider: { list: async () => ({ all: [] }) },
    auth: { set: async () => undefined },
    app: { log: async () => undefined },
  }
  return { client, calls }
}
