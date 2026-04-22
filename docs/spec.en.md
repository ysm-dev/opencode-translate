# `opencode-translate` — Specification

> Status: Draft v2 · Owner: [@ysm-dev](https://github.com/ysm-dev)
> Target platform: [OpenCode](https://github.com/anomalyco/opencode) plugin
> Plugin API: `@opencode-ai/plugin` ( https://opencode.ai/docs/plugins/ )

---

## 1. Goal

Allow an OpenCode user to converse **in any language they prefer** while every
outbound LLM API call goes out in **English only**. The plugin is a translation
proxy that:

1. Translates each user message from the user's native language to English
   before it reaches the main LLM.
2. Keeps the main LLM fully English-only: the model never sees the user's
   original non-English text in the message history it consumes.
3. Translates the main LLM's English response back into the user's configured
   display language for rendering in the TUI / client.
4. Is **session-scoped**: activation happens once per session via a prefix
   keyword (default `$en`) on the first user message, then every subsequent
   message in that session is translated in both directions.

The user types in Korean (or any other language); the LLM sees English; the
user reads the reply rendered as `<english>\n\n---\n\n**<lang>:**\n\n<translated>`.

## 2. Non-Goals (v1)

- No mid-session toggle (`$raw`, `$en off`, `/translate off`). Activation is
  sticky until the session ends.
- No auto-detection of the user's display language. The user configures it
  once in `opencode.json`.
- No TUI plugin companion / status-bar widget. All feedback is delivered via
  synthetic message parts.
- No translation of tool names, tool arguments, or tool output.
- No translation of reasoning ("thinking") parts.
- No translation inside subagent (task tool) sessions.
- No translation of session titles or compaction summaries (deferred to v2
  — see §16).
- No glossary / user dictionary support (v2).

## 3. OpenCode Plugin Integration Constraints

Before describing the design it is worth calling out the concrete limits of
the plugin surface, because they determine what the design can and cannot do.
All line numbers refer to the `dev` branch of
[`anomalyco/opencode`](https://github.com/anomalyco/opencode).

### 3.1 Hook surface used

| Hook | Signature summary | Where the core fires it |
| --- | --- | --- |
| `chat.message` | `(input, output: { message, parts }) => Promise<void>` | `packages/opencode/src/session/prompt.ts:1234` |
| `experimental.chat.messages.transform` | `(input, output: { messages }) => Promise<void>` | `packages/opencode/src/session/prompt.ts:1471` |
| `experimental.text.complete` | `(input, output: { text }) => Promise<void>` | `packages/opencode/src/session/processor.ts:436` |
| `event` | `(input: { event }) => Promise<void>` | `packages/opencode/src/plugin/index.ts:244` (firehose of all `Bus` events, delivered sequentially per plugin) |

`event` is observability-only — it is a firehose but it does **not** feed any
value back into the core. It is not used in v1; the plugin decides everything
it needs from the three mutating hooks above plus the plugin-local in-memory
state.

### 3.2 What plugins can mutate, and when mutations are persisted

| Hook | What we mutate | Is it persisted? |
| --- | --- | --- |
| `chat.message` | `output.message`, `output.parts[]` (including pushing new parts) | **Yes.** Core calls `sessions.updateMessage(info)` and `sessions.updatePart(part)` for every part *after* the hook returns (`prompt.ts:1270-1271`). |
| `experimental.chat.messages.transform` | `output.messages[i].parts[j]` fields (in place) | **No.** The mutated array is only used by the in-progress turn to build the model messages via `MessageV2.toModelMessagesEffect` (`prompt.ts:1477`). Nothing is written back to storage. |
| `experimental.text.complete` | `output.text` (one string per text part) | **Yes.** Core assigns the returned text back (`processor.ts:444`) and then calls `session.updatePart(ctx.currentText)` (`processor.ts:450`). |

### 3.3 What the SDK client can and cannot do

The plugin receives a fully-built `@opencode-ai/sdk` client via `PluginInput`.
Relevant and verified endpoints:

- `client.session.get`, `client.session.messages`, `client.session.message` —
  read access.
- `client.session.update({ path: { id }, body: { title } })` — **only `title`
  can be mutated on a session**; there is no way to patch arbitrary session
  fields.
- `client.session.prompt`, `client.session.promptAsync` — create and send new
  user messages.
- `client.app.log` — structured plugin log output (documented in
  https://opencode.ai/docs/plugins/#logging ).

There is **no** SDK endpoint for updating a stored `Part` from outside a hook
(no `client.session.updatePart`, no PATCH `/session/{id}/message/{id}/part/{id}`,
etc.). Any assistant-part text change has to happen inside the
`experimental.text.complete` hook while the part is being finalised. This is a
*hard* constraint on the design and it is the reason the v1 plan translates
every assistant text part rather than only the last one.

### 3.4 Part schema fields relevant to us

From `packages/opencode/src/session/message-v2.ts:106-122`:

- `TextPart.text: string`
- `TextPart.synthetic?: boolean` — marks a part the user did not author.
- `TextPart.ignored?: boolean` — tells the core to skip this part when
  serialising user messages for the LLM (`toModelMessagesEffect`,
  `message-v2.ts:773`). Assistant-side part serialisation does **not** check
  either of these flags (`message-v2.ts:828-834`).
- `TextPart.metadata?: Record<string, any>` — free-form durable key/value
  attached to the part. Carries our cached translation + hash.

Because `ignored` is respected only on the user side, the plugin cannot hide
content from the LLM by setting `ignored` on assistant parts. The outbound
history-rewrite strategy (see §5.2) exists precisely to solve this on the
assistant side.

### 3.5 Plugin module shape

A plugin is an async factory matching `@opencode-ai/plugin`'s `Plugin` type
and can be exposed in two forms (both accepted by the core loader in
`packages/opencode/src/plugin/shared.ts`):

- **Legacy named-export form** (used by `opencode-md-table-formatter`,
  `opencode-vibeguard`, `CodexAuthPlugin`):

  ```ts
  import type { Plugin } from "@opencode-ai/plugin"

  export const OpencodeTranslate: Plugin = async (ctx, options) => ({
    /* hooks */
  })
  ```

- **V1 module form** (new-style, carries an explicit `id`):

  ```ts
  import type { PluginModule } from "@opencode-ai/plugin"

  export default {
    id: "opencode-translate",
    server: async (ctx, options) => ({ /* hooks */ }),
  } satisfies PluginModule
  ```

v1 of this plugin uses the **legacy named-export form** to match the rest of
the ecosystem and avoid V1-module gotchas.

### 3.6 Plugin options

`PluginOptions` is `Record<string, unknown>` and is delivered as the second
argument to the factory. Opencode lets users pass them via
`opencode.json`:

```json
{ "plugin": [["opencode-translate", { "targetLanguage": "ko" }]] }
```

So `options` is read exactly once, during factory bootstrap.

## 4. Trigger & Lifecycle

### 4.1 Activation

- On the **first user message** of a session, the plugin inspects every text
  part inside the `chat.message` hook.
- If any text part contains any configured `triggerKeywords` token
  (default `["$en"]`) as a whitespace-separated token, the session is marked
  active.
- The matched keyword is **stripped** in place before the message is saved,
  so the LLM never sees the raw keyword.
- A synthetic activation banner is pushed:
  `✓ Translation mode enabled (translator: <model>, display: <lang>)`.
  It is a `TextPart` with `synthetic: true` and `ignored: true` so the LLM
  never receives it, but the UI renders it.

### 4.2 Session scope

Once activated, the session is permanently in translation mode. There is no
deactivation command. To write directly in English, start a new session
without the prefix.

### 4.3 State persistence

The active flag lives on the first user message's first text part:

- `metadata.translate_enabled = true`
- `metadata.translate_user_lang = "<targetLanguage>"`
- `metadata.translate_llm_lang = "en"`

Because `TextPart.metadata` is durable part storage, the flag survives
server restart, session resume, and compaction. The plugin re-reads the
first user message's metadata at the start of each hook invocation, so no
in-memory state is strictly required. A per-process `Map<sessionID, flags>`
is kept purely as a hot-path cache and is refilled lazily.

### 4.4 Detecting "first user message"

Inside `chat.message` the plugin calls `client.session.messages({ path: { id
}, query: { directory } })`. If the returned list has length zero (the
current message is not saved yet at this point), this is the session's first
message.

If it is the first message and a trigger keyword is present, the plugin
activates. If it is not the first message, the plugin reads the first
message's text-part metadata to decide whether the session is in translation
mode.

### 4.5 Subagents (task tool)

When the `task` tool spawns a subagent session, that session is **not**
translation-enabled. Task prompts are already written in English by the
parent LLM, and the user never reads subagent internals directly. The
parent's synthesis of the subagent result flows through a parent-session
text part and is translated through the normal text.complete path.

## 5. Data Flow

### 5.1 Inbound (user → LLM)

```
  User types (Korean, first message includes "$en")
               │
               ▼
  chat.message hook:
    1. list prior messages via client.session.messages; if empty → first msg
    2. scan parts for configured triggerKeywords, strip the match in place
    3. if first msg and keyword was found → mark activation on
       parts[firstText].metadata.translate_enabled = true
    4. if session is translation-enabled:
         a. push a synthetic activation banner part (first turn only),
            { type:"text", synthetic:true, ignored:true, text:"✓ ..." }
         b. for each user TextPart:
              - if metadata.translated_en exists AND hash(part.text) matches
                → skip (already cached)
              - else translate source→English via ai.generateText;
                write part.metadata.translated_en and translated_en_hash
         c. push a synthetic preview part
            { type:"text", synthetic:true, ignored:true,
              text:"→ EN: <translated>" }
    5. the core then persists message + all (mutated + new) parts.
               │
               ▼
  experimental.chat.messages.transform hook (every loop iteration):
    For each user TextPart whose metadata.translate_enabled is true
    OR whose parent session's first user TextPart is translation-enabled:
      - if metadata.translated_en exists → swap part.text with the cached
        English, leaving the canonical part.text in storage untouched
        (transform mutations are not persisted).
      - if missing cache (rare — indicates an out-of-band edit), translate
        on the fly and use the result for this turn only.

    For each assistant TextPart whose text contains the English+target-lang
    format marker (see §5.2), trim the translated tail so only the
    original English half is sent to the LLM.
               │
               ▼
  Main LLM receives English-only conversation.
```

### 5.2 Outbound (LLM → user)

Because there is no SDK endpoint to patch a stored `Part` after the fact
(§3.3), the plugin cannot wait for "message complete" and then translate the
last text part. Every text part is finalised inside the
`experimental.text.complete` hook, and that is the only place we can change
its stored `text`.

```
  Main LLM streams English text-delta events
    • UI renders English live (opencode's default text-delta rendering).
               │
               ▼
  text-end fires for each text part, plugin:
    1. Read input.sessionID → is the session translation-enabled?
       If not, return the text unchanged (no-op, no LLM call).
    2. Translate input.text English → targetLanguage.
    3. Rewrite output.text to the following composite:

         <original English>

         <!-- opencode-translate:divider -->

         ---

         **<language-label> 번역:**

         <translated>

       The HTML comment is the machine-readable divider for §5.1's
       transform step. It is invisible in rendered markdown but uniquely
       recognisable by `indexOf`.
               │
               ▼
  Core persists the dual-language text part via session.updatePart.
  UI re-renders the part with the appended translation.
```

This means **every** assistant text part is translated, not only the final
one. It is a conscious deviation from the "only translate the final answer"
preference captured during product interviews (§18), driven by §3.3. The
cost is bounded: with the default Haiku-class translator, each intermediate
text part costs only a few hundred ms and a few cents-equivalent per turn,
and the resulting UX ("every segment that streams in English gains a Korean
footer when it finishes") is easy to explain to the user.

### 5.3 Session title & compaction

Session titles are generated by OpenCode's own summariser
(`/session/{id}/summarize`). The only way to modify them from a plugin is
`client.session.update({ body: { title } })`. Listening to `session.updated`
events and re-writing the title is technically feasible, but requires a
loop-avoidance marker, so **v1 leaves session titles in English**.

Compaction produces a dedicated `compaction` part (not a text part — see
`packages/opencode/src/session/compaction.ts:478`) and does not flow through
`experimental.text.complete`. In v1 the compaction summary stays English.
Both are candidates for v2 (see §16).

## 6. Translation Engine

### 6.1 Library choice

- **`ai` npm package + provider SDK** (e.g. `@ai-sdk/anthropic`) via
  `generateText`.
- Not via `client.session.prompt` on a scratch session: that would spawn
  real opencode sessions, run every plugin hook recursively, and leak
  sessions into the UI.
- Not via raw HTTP: forces per-provider branching.

### 6.2 Default model

- `anthropic/claude-haiku-4-5` — cheap, fast, strong on code-adjacent text.
- Configurable via `model` in the plugin options.

### 6.3 Authentication

The plugin reads provider API keys from the standard environment variables
consumed by the `@ai-sdk/*` packages (`ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, etc.). The README lists the supported set.
Sharing keys with opencode's stored auth is out of scope for v1.

### 6.4 Retry policy

- Two retries with exponential backoff (500 ms → 1500 ms) on network
  errors and 5xx responses.
- A 429 retries once after `Retry-After`, or after 2 s if the header is
  missing.
- On final failure:
  - **Inbound** (in `chat.message`): push a synthetic error part
    (`❌ Translation failed: <reason>. Turn aborted.`) with
    `synthetic:true, ignored:true` and throw from the hook. The turn is
    aborted before reaching the main LLM. No partial Korean-mixed payload
    goes out.
  - **Outbound** (in `experimental.text.complete`): leave `output.text`
    unchanged and append a trailing marker
    `\n\n<!-- opencode-translate: translation failed: <reason> -->` so the
    transform hook still sees an English-only history on the next turn.
    The user sees the original English, plus a small red synthetic error
    part pushed on the next turn's `chat.message`.

### 6.5 Caching

- **Key**: `sha256(part.text).slice(0, 16)`.
- **Location**: `part.metadata.translated_en` +
  `part.metadata.translated_en_hash` on the user text part. Written by
  `chat.message`; read by `experimental.chat.messages.transform`.
- **Invalidation**: transform compares the stored hash against the current
  `part.text` hash. A mismatch (edited message) forces a fresh translation
  for that turn. Because transform mutations are not persisted, the cache
  itself is not re-written — that happens next time `chat.message` runs for
  that message. This is acceptable: edits are rare and the extra
  translation call is bounded.

### 6.6 Parallelism

In steady state only the newest user message is uncached per turn;
everything else hits the metadata cache. Translation calls are issued
sequentially to preserve ordering and keep provider rate-limits predictable.

## 7. Content Protection

The translator's system prompt enforces strict preservation rules, and a
lightweight post-check validates them.

### 7.1 Protected tokens

- Fenced code blocks (` ``` … ``` `).
- Inline code (`` ` … ` ``).
- File paths (`/Users/…`, `C:\…`, relative paths containing `/` or `\`).
- URLs (`http(s)://`, `ws(s)://`, `file://`, `mailto:`).
- `@mentions`, `#issue` references.
- Markdown structure: headings, ordered/unordered lists, tables,
  blockquotes.
- `camelCase` / `snake_case` / `kebab-case` identifiers without spaces.

### 7.2 Prompt layout

```
System: You are a senior software-engineering translator. Translate from
{SOURCE_LANG} to {TARGET_LANG}.

Hard rules:
 1. Never translate content inside fenced code blocks (```) or inline
    code (`).
 2. Never translate file paths, URLs, @mentions, #refs, or English
    identifiers.
 3. Preserve markdown structure exactly.
 4. If the input is already in {TARGET_LANG}, return it unchanged.
 5. Output only the translation. No commentary, no preamble, no code
    fences around the whole response.

Examples:
  <<few-shot KO→EN example with protected code blocks>>
  <<few-shot EN→KO example with protected paths>>

User: <input>
```

### 7.3 Post-check

After each translation the plugin verifies:

- The count of fenced code blocks (` ``` `) is identical before and after.
- The set of file paths and URLs extracted by a common regex is a
  subset of the input's set.

On failure the plugin retries once with a stricter prompt ("You violated
rule X on the previous attempt. Do not do it again."). A second failure
surfaces through the §6.4 retry/abort policy.

## 8. Configuration

Via `opencode.json`:

```json
{
  "plugin": [
    ["opencode-translate", {
      "model": "anthropic/claude-haiku-4-5",
      "triggerKeywords": ["$en"],
      "targetLanguage": "ko",
      "verbose": false
    }]
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `model` | string | `"anthropic/claude-haiku-4-5"` | Translator model id in `provider/model-id` form understood by `ai`'s provider resolver. |
| `triggerKeywords` | string[] | `["$en"]` | Tokens whose presence in the first user message activates translation mode. Matched as whitespace-separated tokens; case-sensitive. |
| `targetLanguage` | string | `"en"` (= no-op) | User-facing display language, ISO-639-1 preferred (e.g. `ko`, `ja`, `zh`, `de`). Equal to the LLM language (`en`) means the outbound translation step is skipped. |
| `verbose` | boolean | `false` | When `true`, logs translation stats via `client.app.log` (visible with `opencode --log-level debug`). |

The LLM-facing language is fixed to English in v1.

## 9. Translation Targets Matrix

| Content | Translated? | Notes |
| --- | --- | --- |
| User text parts | Yes (source → English) | Cached in `metadata.translated_en`. |
| All assistant text parts | Yes (English → `targetLanguage`) | Every `text-end`. Rendered as dual-language with HTML-comment divider. |
| Reasoning parts | No | Collapsed in UI; translating adds cost without benefit. |
| Session title | No (v1) | See §5.3. Candidate for v2. |
| Compaction summary (`compaction` part) | No (v1) | Not routed through `experimental.text.complete`. Candidate for v2. |
| Tool names / inputs / outputs | No | Internal plumbing; paths and commands are English. |
| Subagent (task) internal messages | No | See §4.5. |

## 10. User Experience Details

### 10.1 Input display

- The user's original message is shown exactly as typed; Korean stays
  Korean in the UI and in storage.
- Directly below the user message, a synthetic text part shows
  `→ EN: <translated>` with `synthetic: true, ignored: true,
  metadata.role: "translation_preview"`. It is visible in the UI and
  excluded from the LLM context because the user-side serialiser
  (`message-v2.ts:773`) skips `ignored:true` text parts.

### 10.2 Output display

During streaming the LLM's English text renders live. When each text part
completes, its stored `text` is rewritten to:

```
<original English text>

<!-- opencode-translate:divider -->

---

**한국어 번역:**

<translated text>
```

The label (`한국어 번역:`) is picked from a small per-language table keyed
by `targetLanguage`; unknown codes fall back to the ISO code in brackets.

### 10.3 Activation banner

On the very first turn of a translation-enabled session, a synthetic text
part appears before the main LLM response:

```
✓ Translation mode enabled · translator: claude-haiku-4-5 · display: ko
```

### 10.4 Failure surfaces

- Inbound failure: synthetic error part `❌ Translation failed: <reason>.
  Turn aborted.` and the turn does not proceed to the LLM.
- Outbound failure: English is left visible (already streamed) and the
  plugin appends a HTML-comment failure marker. On the next turn `chat.message`
  emits a synthetic warning to the user.

## 11. Error Handling Summary

| Stage | Failure | Behaviour |
| --- | --- | --- |
| Inbound translation | Network / 5xx / 429 | 2 retries with backoff; final failure aborts turn. |
| Inbound translation | Post-check fails twice | Aborts turn. |
| Outbound translation | Any failure | Leaves English visible; no retry after streaming completes; emits HTML-comment marker and a next-turn warning. |

## 12. Telemetry & Logging

- `verbose: false` (default) — quiet happy path; only failures and
  unexpected cache misses are logged.
- `verbose: true` — one log line per translation call via
  `client.app.log({ body: { service: "opencode-translate", level: "info",
  message: "translated", extra: { direction, chars_in, chars_out, ms,
  cached, model } } })`.

No data is ever transmitted anywhere except the configured translator
provider.

## 13. Package Layout

Closely mirrors `opencode-md-table-formatter` and `opencode-vibeguard` so
the plugin drops into the existing ecosystem without extra build
orchestration.

```
opencode-translate/
├── src/
│   ├── index.ts          # default named export; hook wiring
│   ├── activation.ts     # keyword detection, metadata state read/write
│   ├── translator.ts     # ai.generateText wrapper, retry, hash cache
│   ├── protect.ts        # code-block/URL/path pre- and post-checks
│   ├── prompts.ts        # system prompt template + few-shot fixtures
│   ├── formatting.ts     # dual-language compose/extract helpers
│   └── constants.ts
├── test/
│   ├── activation.test.ts
│   ├── translator.test.ts    # cache + retry + protect, translator mocked
│   ├── protect.test.ts
│   └── formatting.test.ts
├── docs/
│   └── spec.en.md            # ← this file
├── package.json
├── tsconfig.json
├── README.md
└── .github/workflows/publish.yml
```

### 13.1 `package.json`

```json
{
  "name": "opencode-translate",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "files": ["src", "LICENSE", "README.md"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.14.0"
  },
  "dependencies": {
    "ai": "^4",
    "@ai-sdk/anthropic": "^1",
    "@ai-sdk/google": "^1",
    "@ai-sdk/openai": "^1"
  }
}
```

No compiled `dist/` — opencode's plugin loader runs `.ts` directly under
Bun, the same way `opencode-md-table-formatter` does it.

### 13.2 Entry module

```ts
// src/index.ts
import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { createHooks } from "./activation"

export const OpencodeTranslate: Plugin = async (
  ctx: PluginInput,
  options?: PluginOptions,
) => createHooks(ctx, options ?? {})

export default OpencodeTranslate
```

A named export plus a default export to accommodate both loader paths
(legacy named-export loop and V1 module form).

### 13.3 Installation

```bash
# global install once
npm install -g opencode-translate
# then add to ~/.config/opencode/opencode.json:
# "plugin": [["opencode-translate", { "targetLanguage": "ko" }]]
opencode    # first message in a new session begins with "$en"
```

## 14. Testing Strategy

All automated tests are pure-logic with the translator mocked. Integration
with a real provider is documented as a manual smoke test in the README
and requires an `ANTHROPIC_API_KEY`.

### 14.1 Unit tests

- **`activation.test.ts`**
  - Keyword detection at start, middle, end of part text.
  - Keyword stripping preserves whitespace cleanly.
  - Multiple keywords (`["$en", "$tr"]`) match as disjunction.
  - First-message-only: keyword in second message does not activate.
  - Metadata round-trip: write `translate_enabled` to metadata on a fake
    `{message, parts}` output and read it back.
- **`translator.test.ts`**
  - Hash cache hit skips `generateText`.
  - Hash change (simulated edit) forces re-translation.
  - Retry: 1 simulated transient failure then success.
  - Final failure after retries surfaces a thrown error with a diagnostic
    message.
- **`protect.test.ts`**
  - Fenced code-block count preserved pre/post.
  - File paths unchanged in simulated translator output.
  - Post-check detects a lost code block and triggers the prompt-rewrite
    retry.
- **`formatting.test.ts`**
  - Compose `<EN>\\n\\n<!-- divider -->\\n\\n---\\n\\n**<lang>:**\\n\\n<KO>`.
  - Extract the English half cleanly, including when the translated half
    itself contains a code block.
  - Compose → extract → compose is stable.

### 14.2 Manual smoke test (documented in README)

1. Install the plugin globally.
2. Add it to `~/.config/opencode/opencode.json` with `targetLanguage: "ko"`.
3. Start a new session with:
   `$en 프로젝트 루트의 package.json을 읽고 요약해줘`.
4. Confirm:
   - Synthetic activation banner appears.
   - Synthetic `→ EN: …` preview appears under the user message.
   - LLM response streams in English.
   - After each text part finishes, a Korean translation appears below a
     markdown divider.
   - Subsequent messages without `$en` also translate in both directions.
   - No `$en` on message 1 → plugin is a no-op for the session.

## 15. Implementation Milestones

1. Repo scaffolding: `package.json`, `tsconfig.json`, `.gitignore`, empty
   plugin entry.
2. `translator.ts` + `prompts.ts` — core `ai.generateText` wrapper with
   retries and few-shot prompt.
3. `protect.ts` — preservation pre/post checks.
4. `activation.ts` — keyword detection and first-message metadata.
5. `formatting.ts` — compose/extract helpers for the dual-language
   divider scheme.
6. `chat.message` hook — activation + inbound translation + synthetic
   banners.
7. `experimental.chat.messages.transform` hook — cache lookup + EN
   extraction for assistant parts.
8. `experimental.text.complete` hook — outbound translation + dual-language
   composition.
9. Unit tests.
10. README + examples.
11. Manual smoke test.
12. GitHub Action publishing to npm on `v*` tag pushes.

## 16. Open Questions / Possible v2 Extensions

- **Session title translation** with a loop-avoidance marker on
  `session.updated`.
- **Compaction summary translation** by adding a new hook surface upstream
  (requires opencode core change) or by post-processing the next user-side
  message.
- **TUI companion plugin** for a status-bar translation indicator.
- **`$raw` single-message escape** to send one message untranslated without
  disabling the session.
- **User glossary** (`{ en: "session", target: "세션" }`) for domain
  vocabulary.
- **Auto-detected source language** with a fallback when the user types
  English inside a Korean session.
- **"Only-final-text-part" output translation** if opencode core grows a
  message-complete hook (e.g. `experimental.message.complete`).

None of these block v1.

## 17. Corrections Applied Relative to Draft v1

This section exists because Draft v1 of the spec contained concrete errors
that surfaced only after a careful read of the opencode source and existing
plugins. Keeping a changelog inline makes future re-reads faster.

- **Dropped plan to translate only the last assistant text part** via an
  `event`-hook + `client.session.updatePart` call. `updatePart` does not
  exist on the SDK (§3.3). Replaced with per-`text-end` translation
  (§5.2).
- **Removed v1 scope** for session title and compaction summary
  translation. Deferred to v2 (§5.3, §16).
- **Clarified assistant-side `synthetic`/`ignored` semantics**: the
  user-side serialiser filters them (`message-v2.ts:773`), the
  assistant-side serialiser does not (`message-v2.ts:828-834`). This is
  why outbound-history scrubbing happens in
  `experimental.chat.messages.transform` rather than via a flag on the
  part.
- **Updated repo references** from `sst/opencode` to
  `anomalyco/opencode`, matching the current canonical source of truth.
- **Simplified package layout** to mirror
  `opencode-md-table-formatter` and `opencode-vibeguard`: no build step,
  `src/index.ts` executed directly by Bun, TypeScript types-only.
- **Added §3** (OpenCode plugin integration constraints) as a standalone
  hard-constraint section. Everything below it follows from the facts
  catalogued there.

## 18. Source Interview Summary (for future contributors)

This spec is the output of a design interview. Decisions taken, in order:

1. Activation: first-message keyword → whole-session ON.
2. Storage: keep user's original text, translate to English per turn with
   caching.
3. Translator: dedicated cheap model (default Haiku) configurable.
4. Protect: code blocks, inline code, file paths, URLs, identifiers.
5. Streaming UX: stream English live, append the target-language
   translation when each text part finishes.
6. Input display: show the English preview as a synthetic part beneath
   the user's original.
7. Deactivation: none in v1.
8. Failure handling: 2 retries then abort the turn (inbound) or emit a
   marker (outbound).
9. Reasoning: not translated.
10. Title: kept English in v1.
11. Subagents: not translated.
12. Distribution: public npm package under `ysm-dev`'s GitHub org.
13. Activation state: first user message's part metadata.
14. Source language: any; target language: any (configured).
15. Translator call: direct `ai.generateText`, not SDK prompt.
16. Empty/code-only messages: still translated if prefix present.
17. "Only translate the last answer" preference: acknowledged but
    technically infeasible with today's hook surface (§3.3, §17); every
    text part is translated in v1.
18. Activation announcement: a synthetic banner part.
19. Config options: `model`, `triggerKeywords`, `targetLanguage`,
    `verbose`.
20. Translator prompt: strong instructions + 2 few-shots + preservation
    rules.
21. Display language: configured via `targetLanguage`.
22. Tests: pure-logic only, translator mocked.
23. Debug: errors always; verbose flag for happy-path telemetry.

## 19. References

- OpenCode plugin docs: https://opencode.ai/docs/plugins/
- OpenCode SDK docs: https://opencode.ai/docs/sdk/
- Plugin API types:
  `packages/plugin/src/index.ts` (Hooks, Plugin, PluginInput,
  PluginOptions, PluginModule).
- Hook dispatch sites (all verified against the current `dev` branch at
  spec time):
  - `chat.message`: `packages/opencode/src/session/prompt.ts:1234`
  - `experimental.chat.messages.transform`:
    `packages/opencode/src/session/prompt.ts:1471`
  - `experimental.text.complete`:
    `packages/opencode/src/session/processor.ts:436`
  - `event` (firehose): `packages/opencode/src/plugin/index.ts:244`
- Part schema: `packages/opencode/src/session/message-v2.ts:106-122`
  (TextPart), with user-side `ignored` filter at line 773 and
  assistant-side serialiser starting at line 828.
- ID helpers (for generating synthetic part IDs):
  `packages/opencode/src/id/id.ts` — prefix `prt_`.
- Reference plugins:
  - https://github.com/franlol/opencode-md-table-formatter (uses
    `experimental.text.complete` only; closest shape to ours).
  - https://github.com/inkdust2021/opencode-vibeguard (combines
    `experimental.chat.messages.transform` + `experimental.text.complete`;
    directly parallels our inbound/outbound split).
  - Internal: `packages/opencode/src/plugin/codex.ts`,
    `cloudflare.ts`, `github-copilot/copilot.ts` — canonical examples of
    registering hooks, reading via the SDK, and using
    `chat.params`/`chat.headers`.
