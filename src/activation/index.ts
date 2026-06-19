import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { type PluginClientLike, resolveOptions } from "../constants"
import { createTranslator } from "../translator"
import { createChatMessageHook } from "./chat-message"
import { createEventHook } from "./event"
import { createMessagesTransformHook } from "./messages-transform"
import { createToolExecuteAfterHook, createToolExecuteBeforeHook, resetQuestionSnapshots } from "./question-hooks"
import { resetSessionStateCache } from "./state"
import { createTextCompleteHook } from "./text-complete"
import type { HookContext, HookDependencies } from "./types"

export { extractStoredState } from "./state"
export { findTriggerMatch, stripTriggerKeyword } from "./trigger"

export function __resetActivationCacheForTest() {
  resetSessionStateCache()
  resetQuestionSnapshots()
}

export function createHooks(ctx: PluginInput, rawOptions: PluginOptions = {}, deps: HookDependencies = {}): Hooks {
  if (process.env.OPENCODE_TRANSLATE_DISABLE === "1") return {}

  const client = ctx.client as PluginClientLike
  const options = resolveOptions(rawOptions)
  const hookContext: HookContext = {
    client,
    directory: ctx.directory,
    serverUrl: ctx.serverUrl,
    options,
    translator: deps.translator ?? createTranslator(client, options),
  }

  const hooks: Hooks = {
    "chat.message": createChatMessageHook(hookContext),
    "experimental.chat.messages.transform": createMessagesTransformHook(hookContext),
    "experimental.text.complete": createTextCompleteHook(hookContext),
    "tool.execute.before": createToolExecuteBeforeHook(hookContext),
    "tool.execute.after": createToolExecuteAfterHook(hookContext),
  }

  if (options.assistantTranslation === "final-message") hooks.event = createEventHook(hookContext)
  return hooks
}
