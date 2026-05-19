import type { PluginClientLike, TranslateState } from "../../src/constants"
import type { QuestionArgs } from "../../src/question-tool"

export function fakeClient(state: Partial<TranslateState> = {}): PluginClientLike {
  const translateState = {
    translate_enabled: true,
    translate_user_lang: "Korean",
    translate_llm_lang: "English",
    translate_nonce: "a".repeat(32),
    ...state,
  }

  return {
    session: {
      get: async () => ({ data: { id: "ses_1", parentID: null } }),
      messages: async () => ({
        data: [
          {
            info: { id: "msg_banner", sessionID: "ses_1", role: "user" },
            parts: [
              {
                id: "banner",
                sessionID: "ses_1",
                messageID: "msg_banner",
                type: "text",
                text: "banner",
                synthetic: false,
                ignored: true,
                metadata: { ...translateState, translate_role: "activation_banner" },
              },
            ],
          },
        ],
      }),
      message: async () => ({ data: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant" }, parts: [] } }),
    },
    provider: { list: async () => ({ data: { all: [] } }) },
    auth: { set: async () => ({ data: {} }) },
    app: { log: async () => ({ data: {} }) },
  } as unknown as PluginClientLike
}

export const sampleArgs: QuestionArgs = {
  questions: [
    {
      question: "Are you sure?",
      header: "Confirm",
      options: [
        { label: "Yes, delete", description: "This cannot be undone." },
        { label: "No, cancel", description: "Keep the file." },
      ],
      multiple: false,
      custom: true,
    },
  ],
}

export function cloneSampleArgs(): QuestionArgs {
  return JSON.parse(JSON.stringify(sampleArgs)) as QuestionArgs
}
