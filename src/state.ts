import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"

export const METADATA_KEY = "opencode-translate"
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function readMetadata(value: unknown): { lang: string; english: string; display: string } | undefined {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.lang === "string" && typeof item.english === "string" && typeof item.display === "string") {
    return { lang: item.lang, english: item.english, display: item.display }
  }
}

export function createState(ctx: Plugin.Context) {
  async function lineage(sessionID: string) {
    const ids = [sessionID]
    let current = await ctx.session.get({ sessionID })
    while (current.fork && !ids.includes(current.fork.sessionID)) {
      ids.push(current.fork.sessionID)
      current = await ctx.session.get({ sessionID: current.fork.sessionID })
    }
    return ids
  }
  return {
    async language(sessionID: string): Promise<string | undefined> {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID) return
      const saved = await ctx.storage.get(`sessions/${sessionID}`)
      if (typeof saved === "string") return saved
      if (session.fork) {
        for (const id of (await lineage(sessionID)).slice(1)) {
          const inherited = await ctx.storage.get(`sessions/${id}`)
          if (typeof inherited === "string") return inherited
        }
      }
      // Admission metadata is also a recovery source if setup/prompt was interrupted.
      const messages = await ctx.session.context({ sessionID })
      for (const message of messages) {
        const data = readMetadata(message.metadata?.[METADATA_KEY])
        if (message.type === "user" && data) {
          await ctx.storage.set(`sessions/${sessionID}`, data.lang)
          return data.lang
        }
      }
    },
    async remember(sessionID: string, display: string, english: string) {
      await ctx.storage.set(`text/${sessionID}/${hash(display)}`, { display, english })
    },
    async question(sessionID: string, callID: string) {
      for (const id of await lineage(sessionID)) {
        const value = await ctx.storage.get(`questions/${id}/${callID}`)
        if (typeof value === "string") return value
      }
    },
    async english(sessionID: string, display: string): Promise<string> {
      const saved = await ctx.storage.get(`text/${sessionID}/${hash(display)}`)
      if (
        saved &&
        typeof saved === "object" &&
        "display" in saved &&
        "english" in saved &&
        saved.display === display &&
        typeof saved.english === "string"
      ) {
        return saved.english
      }
      // Responses can concatenate several native text parts into one semantic
      // message. Restore their recorded spans as well as exact whole messages.
      if (!display.includes("\n\n---\n\n")) return display
      let text = display
      for (const id of await lineage(sessionID)) {
        let after: string | undefined
        do {
          const page = await ctx.storage.scan({ prefix: `text/${id}/`, after, limit: 100 })
          for (const { value } of page.entries) {
            if (
              value &&
              typeof value === "object" &&
              "display" in value &&
              "english" in value &&
              typeof value.display === "string" &&
              typeof value.english === "string" &&
              value.display !== value.english
            ) {
              text = text.replaceAll(value.display, value.english)
            }
          }
          after = page.next
        } while (after)
      }
      return text
    },
  }
}
