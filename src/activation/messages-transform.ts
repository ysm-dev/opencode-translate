import type { Hooks } from "@opencode-ai/plugin"
import { isTextPart, type MessageWithPartsLike } from "../constants"
import { extractEnglishHistoryText } from "../formatting"
import { logError } from "./logging"
import { isTranslatedUserDisplayPart } from "./metadata"
import { resolveSessionState } from "./state"
import type { HookContext } from "./types"

type MessagesTransformHook = NonNullable<Hooks["experimental.chat.messages.transform"]>

export function createMessagesTransformHook(ctx: HookContext): MessagesTransformHook {
  return async (_input, output) => {
    try {
      const sessionID = output.messages[0]?.info.sessionID
      if (!sessionID) return

      const resolved = await resolveSessionState(ctx.client, ctx.directory, sessionID)
      const activeState = resolved.state
      if (!activeState) return

      for (const message of output.messages as MessageWithPartsLike[]) {
        if (message.info.role === "user") {
          for (const part of message.parts) {
            if (isTranslatedUserDisplayPart(part)) part.ignored = true
          }
          continue
        }

        if (message.info.role !== "assistant") continue
        for (const part of message.parts) {
          if (isTextPart(part)) part.text = extractEnglishHistoryText(part.text, activeState.translate_nonce)
        }
      }
    } catch (error) {
      await logError(ctx.client, error)
    }
  }
}
