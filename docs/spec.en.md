# `opencode-translate` — Specification

> Status: Draft v5 · Owner: [@ysm-dev](https://github.com/ysm-dev)
> Target platform: [OpenCode](https://github.com/anomalyco/opencode) plugin
> Plugin API: `@opencode-ai/plugin` ( https://opencode.ai/docs/plugins/ )

---

## 1. Goal

Allow an OpenCode user to converse **in their configured `sourceLanguage`**
while the **main chat loop** (and its compaction summariser) see **English
only**. The plugin is a translation proxy that:

1. Translates each user message from `sourceLanguage` to English before it
   reaches the main-chat LLM.
2. Keeps the main-chat LLM fully English-only: the model never sees the
   user's original non-English text in the message history it consumes in
   the main loop (`packages/opencode/src/session/prompt.ts:1471`) or in
   the compaction summariser
   (`packages/opencode/src/session/compaction.ts:303`). Both paths invoke
   `experimental.chat.messages.transform`, which is where the plugin swaps
   stored source-language text for cached English before
   `MessageV2.toModelMessagesEffect` serialises it.
3. Translates the main LLM's English response back into the user's
   configured `displayLanguage` for rendering in the TUI / client.
4. Is **session-scoped**: activation happens once per session via a prefix
   keyword (default `$en`) on the first user message, then every
   subsequent message in that session is translated in both directions.

The user types in, for example, Korean (or any other configured source
language); the main-chat LLM sees English; the user reads the reply as
`<english>\n\n<start-marker>\n---\n\n**<lang>:**\n\n<translated>\n<end-marker>`
where the markers are session-unique (see §5.2).

Paths that **do not** flow through `experimental.chat.messages.transform`
— most importantly the **title generation** path at
`packages/opencode/src/session/prompt.ts:157-217`, which calls
`MessageV2.toModelMessagesEffect(context, mdl)` on the raw stored user
parts (line 188) — are explicitly out of scope in v1 (see §5.3, §16).

## 2. Non-Goals (v1)

- No mid-session toggle (`$raw`, `$en off`, `/translate off`). Activation
  is sticky until the session ends.
- No auto-detection of the user's source or display language. Both are
  configured once in `opencode.json`.
- No TUI plugin companion / status-bar widget. All feedback is delivered
  via plugin-owned synthetic message parts and the native session-error
  stream.
- No translation of tool names, tool arguments, or tool output.
- No translation of reasoning ("thinking") parts.
- No translation inside subagent (task tool) sessions.
- **No enforcement of English-only on the title generation path.** The
  core title generator at `prompt.ts:186-200` does not fire
  `experimental.chat.messages.transform`, so the title LLM receives the
  user's original (source-language) first message. The stored title will
  therefore typically be in the source language in v1. This is a known
  limitation; see §5.3 and §16.
- No re-rendering of the stored `compaction` summary part into
  `displayLanguage`. The compaction LLM does see English thanks to §5.1,
  but the resulting summary part is saved in English and left alone in
  v1.
- No self-healing of stale per-part translation caches for *edited
  historical* user messages. An edit detected at translate time aborts
  the turn (see §6.5).
- No multi-variable provider credential synthesis. Providers whose
  credentials require more than one env var (e.g. `@ai-sdk/amazon-bedrock`
  needs `AWS_REGION` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`;
  `@ai-sdk/google-vertex` needs project + location + key; Cloudflare
  needs account + gateway + token) are not synthesised by the plugin;
  the translator delegates to each `@ai-sdk/*` package's own env-var
  discovery (§6.3.3).
- No glossary / user dictionary support (v2).

## 3. OpenCode Plugin Integration Constraints

Before describing the design it is worth calling out the concrete limits
of the plugin surface, because they determine what the design can and
cannot do. All line numbers refer to the local checkout at
`/Users/chris/git/opencode` (which tracks `anomalyco/opencode` `dev`).

### 3.1 Hook surface used

| Hook | Signature summary | Where the core fires it |
| --- | --- | --- |
| `chat.message` | `(input, output: { message, parts }) => Promise<void>` | `packages/opencode/src/session/prompt.ts:1234` |
| `experimental.chat.messages.transform` | `(input, output: { messages }) => Promise<void>` | Main chat loop: `packages/opencode/src/session/prompt.ts:1471`. Compaction summariser: `packages/opencode/src/session/compaction.ts:303`. **Not** fired in the title path (`prompt.ts:157-217`). |
| `experimental.text.complete` | `(input, output: { text }) => Promise<void>` | `packages/opencode/src/session/processor.ts:436` |
| `event` | `(input: { event }) => Promise<void>` | `packages/opencode/src/plugin/index.ts:244` (firehose of all `Bus` events, delivered sequentially per plugin) |

`event` is observability-only and is not used in v1.

### 3.2 What plugins can mutate, and when mutations are persisted

| Hook | What we mutate | Is it persisted? |
| --- | --- | --- |
| `chat.message` | `output.message`, `output.parts[]` (including pushing new parts) | **Yes — but only if the hook returns normally.** Core calls `sessions.updateMessage(info)` and `sessions.updatePart(part)` for every part *after* the hook returns (`prompt.ts:1270-1271`). **If the hook throws, nothing we pushed into `output.parts` is saved** — the exception propagates out of `createUserMessage` and aborts the turn. This is why the v1 failure model for inbound translation is a **thrown error surfaced through the caller's normal error transport**, not a synthetic "translation failed" part (§6.4). |
| `experimental.chat.messages.transform` | `output.messages[i].parts[j]` fields (in place) | **No.** The mutated array is only used by the in-progress turn to build the model messages via `MessageV2.toModelMessagesEffect` (`prompt.ts:1477`, `compaction.ts:304`). Nothing is written back to storage. |
| `experimental.text.complete` | `output.text` (one string per text part) | **Yes.** Core assigns the returned text back (`processor.ts:444`) and then calls `session.updatePart(ctx.currentText)` (`processor.ts:450`). The hook cannot write durable plugin metadata; only the `text` field round-trips. |

### 3.3 What the SDK client can and cannot do

The plugin receives a fully-built `@opencode-ai/sdk` client via
`PluginInput`. Relevant and verified endpoints:

- `client.session.get({ sessionID, directory?, workspace? })`,
  `client.session.messages({ sessionID, directory?, workspace? })`,
  `client.session.message({ sessionID, messageID, directory?, workspace? })`
  — read access. `Session.parentID` is part of the returned schema
  (`packages/sdk/js/src/v2/gen/types.gen.ts:933-940`) and is how the
  plugin identifies subagent (`task` tool) sessions (§4.5).
- `client.session.update({ sessionID, title?, permission?, time? })` —
  **only `title`, `permission`, and `time.archived` can be mutated on a
  session**
  (`packages/sdk/js/src/v2/gen/types.gen.ts:3405-3421`); there is no way
  to patch arbitrary session fields.
- `client.session.prompt`, `client.session.promptAsync` — create and send
  new user messages.
- `client.provider.list()` — `GET /provider`, returns
  `ProviderListResponse` with `all: Provider[]`. Each `Provider` carries
  `id`, `source ∈ {"env","config","custom","api"}`, `env: string[]`,
  `key?: string`, `options: Record<string,unknown>`, `models: {...}`
  (`packages/sdk/js/src/gen/types.gen.ts:1514-1526`). Used by the
  translator to resolve credentials per §6.3.1. `key` is already resolved
  from env or stored auth when `source` is `"env"` or `"api"`; it is
  absent/empty/the sentinel `OAUTH_DUMMY_KEY` when `source` is `"custom"`
  or when the provider requires multiple env vars.
- `client.auth.set({ path:{id}, body: Info })` — `PUT /auth/{id}`,
  (`packages/sdk/js/src/gen/sdk.gen.ts:916-925`). Used to persist
  refreshed OAuth tokens back to `auth.json` after the plugin refreshes
  them (§6.3.2). Body schema mirrors the opencode `Auth.Info` discriminated
  union: `{type:"api", key, metadata?}`, `{type:"oauth", access, refresh,
  expires, accountId?, enterpriseUrl?}`, or `{type:"wellknown", key, token}`.
- `client.app.log` — structured plugin log output.

There is **no** SDK endpoint for updating a stored `Part` from outside a
hook. Any assistant-part text change has to happen inside the
`experimental.text.complete` hook while the part is being finalised. This
is a *hard* constraint on the design and it is the reason v1 translates
every assistant text part rather than only the last one (see §5.2, §17).

There is also **no** SDK endpoint that reads auth records (no
`client.auth.list()`, no `client.auth.get()`). `client.provider.list()`
is the closest substitute; for OAuth records (which opencode hides
behind a per-provider plugin fetch wrapper) the plugin reads `auth.json`
directly, honouring the `OPENCODE_AUTH_CONTENT` env override (§6.3.2).

This spec uses the **JavaScript SDK call shape** in examples, not the raw
HTTP route shape. Where the underlying route internally distinguishes
path/query/body, the SDK flattens those arguments into one parameter
object.

### 3.4 Part schema fields relevant to us

From `packages/opencode/src/session/message-v2.ts`:

- `TextPart.text: string`
- `TextPart.synthetic?: boolean` — marks a part the user did not author.
- `TextPart.ignored?: boolean` — tells the core to skip this part when
  serialising user messages for the LLM (`toModelMessagesEffect`,
  `message-v2.ts:773`). Assistant-side part serialisation does **not**
  check either of these flags (`message-v2.ts:828-834`).
- `TextPart.metadata?: Record<string, any>` — free-form durable key/value
  attached to the part. Carries our cached translation and activation
  state.

Because `ignored` is respected only on the user side, the plugin cannot
hide content from the LLM by setting `ignored` on assistant parts. The
outbound history-rewrite strategy (see §5.2) exists precisely to solve
this on the assistant side.

### 3.5 Plugin module shape

v1 of this plugin uses the **legacy named-export form** to match the rest
of the ecosystem and avoid V1-module gotchas:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const OpencodeTranslate: Plugin = async (ctx, options) => ({
  /* hooks */
})
export default OpencodeTranslate
```

### 3.6 Plugin options

`PluginOptions` is `Record<string, unknown>` and is delivered as the
second argument to the factory. Users pass them via `opencode.json`:

```json
{
  "plugin": [["opencode-translate", {
    "sourceLanguage": "ko",
    "displayLanguage": "ko"
  }]]
}
```

So `options` is read exactly once, during factory bootstrap.

### 3.7 Paths that bypass `experimental.chat.messages.transform`

These paths build model messages via `MessageV2.toModelMessagesEffect`
directly from stored parts, without first letting plugins rewrite the
history:

- **Title generation** (`prompt.ts:188`) — receives the raw
  source-language first user message. The plugin cannot force this LLM
  call to English in v1.
- **`experimental.text.complete`** itself is per-part; it does not
  re-enter the transform path.

Anything that *does* flow through transform — the main loop and the
compaction summariser — will see English after the plugin swaps text
in-place. This asymmetry is the single most important fact about what v1
can and cannot guarantee.

## 4. Trigger & Lifecycle

### 4.1 Activation

- On the **first user message** of a session (and only on a **root**
  session — `session.parentID` must be absent; see §4.5), the plugin
  inspects every text part inside the `chat.message` hook.
- If any text part contains any configured `triggerKeywords` token
  (default `["$en"]`) as a whitespace-separated token, the session is
  marked active.
- The matched keyword is **stripped** in place before the message is
  saved, so the LLM never sees the raw keyword.
- A plugin-owned activation banner part is pushed *and used as the
  canonical state anchor*. It is a `TextPart` with
  `synthetic: true, ignored: true` and metadata:

  ```ts
  {
    translate_enabled: true,
    translate_source_lang: "<sourceLanguage>",
    translate_display_lang: "<displayLanguage>",
    translate_llm_lang: "en",
    translate_nonce: "<32-char lowercase hex, per session>",
    translate_role: "activation_banner",
    translate_spec_version: 1,
  }
  ```

  The banner is visible in the UI and is excluded from the LLM context
  because `ignored: true` is respected on the user side.
- `translate_nonce` is generated exactly once on activation as
  `crypto.randomBytes(16).toString("hex")`. Implementations MUST emit
  lowercase hex and MUST reject any recovered nonce that does not match
  `/^[0-9a-f]{32}$/`.

### 4.2 Session scope

Once activated, the session is permanently in translation mode. There is
no deactivation command. To write directly in English, start a new
session without the prefix.

### 4.3 State persistence

The canonical state lives on the activation banner part (§4.1). For
resilience the same metadata is **duplicated** onto every user-authored
text part the plugin translates, so losing the banner part (e.g. deleted
in a UI workflow we do not control) does not silently disable translation
for the rest of the session.

Durable keys written to each translated user `TextPart.metadata`:

- `translate_enabled: true`
- `translate_source_lang: "<sourceLanguage>"`
- `translate_display_lang: "<displayLanguage>"`
- `translate_llm_lang: "en"`
- `translate_nonce: "<session nonce>"`
- `translate_source_hash: "<lowercase hex sha256(UTF-8(part.text)).slice(0,16)>"`
- `translate_en: "<English translation>"`

Because `TextPart.metadata` is durable part storage, the flags survive
server restart, session resume, and compaction. At the start of each hook
invocation the plugin reads these flags from the activation banner (first
preference) or from any translation-enabled user text part (fallback). A
per-process `Map<sessionID, flags>` is kept purely as a hot-path cache
and is refilled lazily from metadata.

### 4.4 Detecting "first user message" and active sessions

Inside every hook invocation the plugin resolves translation state using
this exact algorithm:

1. Read the session via
   `client.session.get({ sessionID, directory: ctx.directory })`.
2. If `session.parentID != null`, the session is **inactive** and the
   plugin returns immediately from the hook (§4.5).
3. Read stored messages via
   `client.session.messages({ sessionID, directory: ctx.directory })`.
4. Scan stored parts for a **valid translation state record**. A record is
   valid only if all of the following hold:
   - `metadata.translate_enabled === true`
   - `metadata.translate_llm_lang === "en"`
   - `metadata.translate_source_lang` is a non-empty string
   - `metadata.translate_display_lang` is a non-empty string
   - `metadata.translate_nonce` matches `/^[0-9a-f]{32}$/`
5. If a valid activation-banner record exists
   (`metadata.translate_role === "activation_banner"`), that record wins.
6. Else, if any valid user-text-part record exists, the session is active
   and inherits that record.
7. Else, if and only if `storedMessages.length === 0`, the session is a
   **fresh root session** and the current unsaved message is the only
   activation candidate. The plugin may scan this message for a trigger
   keyword.
8. Else, the session is inactive. Later messages in that session cannot
   activate translation mode.

This is the entire activation model for v1. There is no separate notion
of "resumed" vs "continued" vs "imported" sessions: if valid
translation metadata exists in stored history, the session is active;
otherwise only an empty root session may activate.

### 4.5 Subagents (task tool)

When the `task` tool spawns a subagent, the new session is created with
`parentID` set to the invoking session
(`packages/opencode/src/tool/task.ts:67-71` passes
`parentID: ctx.sessionID` to `sessions.create`). The plugin treats any
session with a non-null `parentID` as **not translation-enabled** and
returns from every hook as a no-op for such sessions. Task prompts are
already written in English by the parent LLM, and the user never reads
subagent internals directly. The parent's synthesis of the subagent
result flows through a parent-session text part and is translated through
the normal `experimental.text.complete` path.

### 4.6 Forked sessions

`session.fork` clones prior messages and part metadata into a brand-new
root session (`packages/opencode/src/session/session.ts:534-566`). In v1,
this means:

1. If the source session was translation-enabled, the forked session is
   also translation-enabled immediately because valid translation
   metadata is copied into stored history.
2. No new trigger keyword is required after a fork.
3. If the source session was not translation-enabled, the forked session
   is also not translation-enabled; since it is no longer empty, it can
   never be activated later.

This inheritance is intentional for UX consistency. Users who want a raw
English continuation must start a brand-new session, not fork a
translation-enabled one.

## 5. Data Flow

### 5.1 Inbound (user → LLM)

```
  User types (Korean, first message includes "$en")
               │
               ▼
  chat.message hook:
    0. session = client.session.get({ sessionID, directory }) → if
       session.parentID, return
       immediately (subagent).
    1. prior = client.session.messages({ sessionID, directory }).
    2. Resolve active state exactly as in §4.4.
    3. If this is a fresh root session with no stored messages, scan the
       current unsaved message for a trigger keyword and, if found,
       activate the session.
    4. If activation occurred on this turn, create the activation banner
       part (§4.1) with a fresh 32-char lowercase hex session nonce.
    5. if session is translation-enabled:
          a. for each user-authored TextPart (skip synthetic / ignored
             parts; §6.6):
              - if stripping the activating keyword left this part empty
                after `trim()`, leave the part text as-is and do NOT
                translate it and do NOT emit a preview for it
              - translate source→English via ai.generateText
              - write durable metadata on the part:
                  translate_enabled, translate_source_lang,
                  translate_display_lang, translate_llm_lang,
                  translate_nonce, translate_source_hash,
                  translate_en.
         b. push one plugin-owned preview part per translated source
            text part, immediately after that source text part:
             { type:"text", synthetic:true, ignored:true,
               text:"→ EN: <translated>",
               metadata: { translate_role: "translation_preview",
                           translate_nonce, translate_source_hash,
                           translate_part_index } }
         c. If activation occurred on this turn, append exactly one
            activation banner as the FINAL part of the message.
    6. If any translation in (5a) fails after §6.4's retry policy, the
       hook THROWS. The core has not yet persisted anything from this
       turn (it persists after the hook returns; §3.2), so no partial
       state leaks to storage. The error surfaces through
       the caller's normal error path (§6.4, §10.4). No synthetic
       "translation failed" part is pushed, because such a part would
       also not be persisted after a throw.
    7. The core then persists message + all (mutated + new) parts.
               │
               ▼
  experimental.chat.messages.transform hook
  (main loop per iteration, and also compaction.ts:303):

    Pure cache lookup — NO network calls here.

    For each user TextPart whose metadata.translate_enabled is true,
    AND whose metadata.translate_nonce matches the active session nonce,
    AND whose metadata.translate_source_hash matches
        lowercase-hex sha256(UTF-8(part.text)).slice(0,16):
      - swap part.text with metadata.translate_en for this in-memory
        pass (mutations are not persisted).

    For each user TextPart that SHOULD have been translated (translation
    is active, the part is user-authored, part.text is non-empty) but
    whose cache is missing OR whose hash does not match:
      - do NOT translate on the fly — see §6.5. Throw the exact
        `STALE_CACHE` error from §6.4. The turn is aborted before the
        main LLM is called. v1 does not self-heal edited historical
        messages.

    For each assistant TextPart whose stored text contains the outbound
    nonce trailer (see §5.2) matching the active session nonce, trim
    everything from the start marker onward so only the original English
    half is sent to the LLM. Synthetic user-side parts (ours) are
    already excluded via ignored:true on the user side, and we never
    push assistant-role parts.
               │
               ▼
  Main-chat LLM (and compaction LLM) receives English-only conversation.
```

**Exact trigger-matching and part-ordering rules**

- The plugin iterates the current message's user-authored text parts in
  stored order.
- Trigger matching runs only when `storedMessages.length === 0` and only
  across those user-authored text parts.
- For each part in order, and for each keyword in `triggerKeywords`
  order, the plugin searches for the first match of the exact
  ECMAScript pattern `(^|[ \t\r\n\f\v])KEYWORD(?=$|[ \t\r\n\f\v])`
  with `KEYWORD` escaped literally.
- The first match by part order, then character offset, then keyword
  array order wins. Exactly **one** match is ever consumed; later
  occurrences are left untouched as literal user content.
- Removal uses these exact replacements, in order, on the matched span's
  local line only:
  - line-start form: `KEYWORD ` → ``
  - line-end form: ` KEYWORD` → ``
  - surrounded form: ` KEYWORD ` → ` `
  - bare form: `KEYWORD` → ``
- No other whitespace normalization is performed. Newlines are never
  added, removed, or collapsed by trigger stripping.
- The plugin MUST preserve the original order of all existing user parts.
  It may only insert synthetic preview parts immediately after the source
  text part they describe, plus a single activation banner at the very
  end of the message on the activation turn.
- `translate_part_index` is the zero-based ordinal of the translated
  user-authored text part within the original message's eligible text
  parts.

### 5.2 Outbound (LLM → user)

Every text part is finalised inside `experimental.text.complete`, and
that is the only place the plugin can change its stored `text` (§3.3).
The plugin rewrites the text to an English+display composite delimited
by **session-unique** HTML-comment markers so later transforms can
reliably locate the divider even if the model itself happens to emit
plain `<!-- ... -->` comments or `---` rules in its output:

```
<original English>

<!-- oc-translate:{nonce}:start -->
---

**{displayLanguageLabel}:**

<translated>
<!-- oc-translate:{nonce}:end -->
```

`{nonce}` is the 32-character lowercase hex value minted at activation
(§4.1) and
copied onto every text part the plugin emits. The transform step (§5.1)
strips only a **structurally valid trailer** before handing history to
the LLM. The parser is exact:

1. The start marker line must be exactly
   `<!-- oc-translate:{nonce}:start -->`.
2. The optional failure-status line must be exactly
   `<!-- oc-translate:{nonce}:status:failed -->` and, if present, must
   appear immediately after the start marker.
3. The end marker line must be exactly
   `<!-- oc-translate:{nonce}:end -->`.
4. The parser searches from the end of the text for the last exact end
   marker with the active nonce.
5. It then searches backward for the nearest preceding exact start marker
   with the same nonce.
6. The candidate is valid only if the end marker is the last non-empty
   line in the part and the lines between start and end match one of the
   two layouts shown in this section (success trailer or failure
   trailer).
7. If the candidate is valid, the English half is the exact prefix of
   the text before the blank line immediately preceding the start marker.
8. If the candidate is not valid, the part is treated as plain English
   and **nothing is trimmed**.

On translation failure in this hook, the plugin leaves `output.text`
unchanged and appends a failure trailer using the same nonce:

```
<original English>

<!-- oc-translate:{nonce}:start -->
<!-- oc-translate:{nonce}:status:failed -->
---

_Translation unavailable for this segment._

<!-- oc-translate:{nonce}:end -->
```

This keeps the transform path symmetric on the next turn (the whole
trailer is stripped before the LLM sees history), and surfaces the
failure inline to the user immediately instead of waiting for the next
turn.

Every assistant text part is translated — not only the final one. This
is a conscious deviation from the "only translate the final answer"
preference captured during product interviews (§18), driven by §3.3.

### 5.3 Session title, compaction, and other core-internal LLM calls

**Compaction summariser.** Runs through
`experimental.chat.messages.transform` (`compaction.ts:303`), so the
compaction LLM sees English. The *stored* compaction summary part is
whatever text the compaction LLM produced (English) and will not
re-render in the user's `displayLanguage` in v1. Because compaction
summaries surface inside the prompt as "What did we do so far?" via
`message-v2.ts:795-800`, leaving them in English keeps downstream LLM
turns consistent.

**Session title.** The title path
(`packages/opencode/src/session/prompt.ts:157-217`) calls
`MessageV2.toModelMessagesEffect(context, mdl)` on line 188 directly on
the stored parts — it does **not** invoke
`experimental.chat.messages.transform`. The plugin therefore cannot
force this LLM call to English in v1. The stored title will typically
be in the source language. The only way to change this from a plugin
would be to:

- land a new upstream hook (e.g. `experimental.session.title`), or
- listen to `session.updated` and issue
  `client.session.update({ sessionID, title })` with a loop-avoidance
  marker to translate the title after the fact.

Both are v2 candidates; see §16.

## 6. Translation Engine

### 6.1 Library choice

- **`ai` npm package + provider SDK** (e.g. `@ai-sdk/anthropic`) via
  `generateText`.
- Not via `client.session.prompt` on a scratch session: that would
  spawn real opencode sessions, run every plugin hook recursively, and
  leak sessions into the UI.
- Not via raw HTTP: forces per-provider branching.

### 6.2 Default model

- `anthropic/claude-haiku-4-5` — cheap, fast, strong on code-adjacent
  text.
- Configurable via `translatorModel` in the plugin options.

### 6.3 Authentication

The translator shares credentials with opencode's stored auth from v1.
The plugin resolves an `apiKey` (and, for OAuth-backed providers, a
custom `fetch`) before every translator call using the priority order
below. No new config option is introduced; users who run `opencode auth
login <provider>` automatically make that credential available to the
translator.

#### 6.3.1 Credential resolution order

For the provider `P` parsed from `translatorModel` (e.g. `"anthropic"`
from `"anthropic/claude-haiku-4-5"`), the resolver produces
`{ apiKey?: string, fetch?: typeof fetch }` using the first match:

1. **Plugin option.** If `options.apiKey` is set in `opencode.json`, use
   it as `apiKey`. No `fetch` override.
2. **opencode stored auth via SDK.** Call `client.provider.list()`, find
   `p = result.all.find(x => x.id === P)`:
   - If `p.source === "api"` and `p.key` is a non-empty string not equal
     to `OAUTH_DUMMY_KEY` (`"opencode-oauth-dummy-key"`,
     `packages/opencode/src/auth/index.ts:7`), use `p.key` as `apiKey`.
     This is the `auth login → Manually enter API Key` path.
   - Else if `p.source === "env"` and `p.key` is a non-empty string, use
     `p.key` as `apiKey`. opencode has already resolved the env var for
     us; reusing the resolved value avoids process-env drift between the
     plugin factory and later hook invocations.
   - Else if `p.source === "custom"` **or** `p.key === OAUTH_DUMMY_KEY`,
     engage the OAuth reuse path in §6.3.2. Sets both `apiKey: ""` and
     a custom `fetch` wrapper.
   - Else if `p.key` is `undefined` and `p.env.length > 1`, the provider
     is multi-var: follow §6.3.3.
3. **`@ai-sdk/*` package default.** If nothing above resolves, pass no
   `apiKey` to the factory and let the `@ai-sdk/*` package read its
   canonical env var(s) on its own (e.g. `@ai-sdk/anthropic` reads
   `ANTHROPIC_API_KEY`; `@ai-sdk/google` reads
   `GOOGLE_GENERATIVE_AI_API_KEY`; `@ai-sdk/openai` reads
   `OPENAI_API_KEY`). This preserves the previous v4 behaviour as a
   fallback.
4. **Error.** If even step 3 yields a factory that throws at call time
   for missing credentials, the resolver translates that into the
   `AUTH_UNAVAILABLE` error (§6.4).

The resolver runs **once per translator call** but memoises its result
for the same provider for the process lifetime, except for OAuth
wrappers where the `fetch` itself re-resolves the access token per
request (§6.3.2). Resolution errors are never cached; every call
re-attempts.

#### 6.3.2 OAuth reuse

Three OAuth-backed providers are supported. When any of them is selected
via `translatorModel` and resolution reaches the "engage OAuth reuse"
branch of §6.3.1 step 2, the plugin reconstructs the minimum viable
authenticated-request shape per provider.

**Auth file discovery.** The plugin reads the raw `auth.json` map in
this order:

1. `process.env.OPENCODE_AUTH_CONTENT`, if set, parsed as a JSON object
   (`Record<providerID, Info>`), matching
   `packages/opencode/src/auth/index.ts:59-63`.
2. `$XDG_DATA_HOME/opencode/auth.json` — resolved via `xdg-basedir`
   semantics. Fallbacks per platform:
   - macOS: `~/Library/Application Support/opencode/auth.json`
   - Linux: `~/.local/share/opencode/auth.json`
   - Windows: `%LOCALAPPDATA%\opencode\auth.json`
3. If neither exists or the file fails to parse as JSON with mode 0o600,
   OAuth reuse returns `undefined` and the resolver falls through to
   step 3 of §6.3.1.

**Per-provider request shape.**

| `providerID` | Refresh endpoint | Request body | Bearer source | Extra required on every request |
| --- | --- | --- | --- | --- |
| `anthropic` | `POST https://console.anthropic.com/v1/oauth/token` | `{"grant_type":"refresh_token","refresh_token":<refresh>,"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}` (Content-Type: `application/json`) | `info.access` | `Authorization: Bearer <access>`; `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14`; `anthropic-version: 2023-06-01`; delete `x-api-key`; optional `?beta=true` query on `/v1/messages`. |
| `openai` (Codex) | `POST https://auth.openai.com/oauth/token` | `{"grant_type":"refresh_token","refresh_token":<refresh>,"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","scope":"openid profile email offline_access"}` (form body) | `info.access` | `Authorization: Bearer <access>`; `ChatGPT-Account-Id: <info.accountId>`; URL rewrite from `api.openai.com/v1/chat/completions` and `api.openai.com/v1/responses` to `https://chatgpt.com/backend-api/codex/responses`. |
| `github-copilot` | Token exchange `GET https://api.github.com/copilot_internal/v2/token` with `Authorization: token <info.refresh>` | n/a (bearer GitHub PAT in `refresh`) | session token returned by exchange (expires per response) | `Authorization: Bearer <session_token>`; `Editor-Version: opencode-translate/<version>`; `Editor-Plugin-Version: opencode-translate/<version>`; `Copilot-Integration-Id: vscode-chat`. If `info.enterpriseUrl` is set, use it as base URL instead of `api.githubcopilot.com`. |

**Refresh semantics.**

- Each OAuth record is checked with `expires < Date.now() + 60_000` (a
  60-second safety margin). opencode's own OAuth plugins use a zero
  margin (`plugin/codex.ts:417`); we add the margin to absorb clock
  skew and in-flight request latency.
- Refreshes are **serialised per providerID** through an in-process
  `Map<providerID, Promise<Info>>`. Concurrent translator calls coalesce
  onto a single refresh promise so rotated refresh tokens do not
  invalidate each other — a real race in opencode's own plugins that
  this plugin must not reproduce.
- After a successful refresh, the new `{access, refresh, expires}` is
  persisted via `client.auth.set({ path: { id: providerID }, body: {
  type: "oauth", access, refresh, expires, accountId?, enterpriseUrl? }
  })` so opencode and the plugin stay in sync. The plugin never writes
  `auth.json` directly.
- Reads from `auth.json` are always re-hydrated from disk (or from
  `OPENCODE_AUTH_CONTENT` if set); only the in-flight refresh promise is
  cached in process.

**Request adapter.** For OAuth providers the plugin constructs the
`@ai-sdk/<pkg>` factory with `{ apiKey: "", fetch: customFetch }` where
`customFetch(input, init)`:

1. Calls `resolveOAuth(providerID)` which refreshes if needed and returns
   the current `Info`.
2. Sets `Authorization: Bearer <info.access>` (or the token-exchange
   result for Copilot) and the provider-specific extra headers listed
   above.
3. Deletes `x-api-key` where required (Anthropic).
4. Rewrites the URL where required (Codex).
5. Delegates to global `fetch` and returns its `Response`.

The plugin does **not** replicate abuse-detection evasions that opencode
itself removed in commit `1ac1a0287` ("anthropic legal requests"):
tool-name `mcp_` prefix rewriting, User-Agent spoof (`claude-cli/2.1.2
(external, cli)`), and system-prompt text substitution (`OpenCode` →
`Claude Code`). Requests go out with the plugin's own User-Agent
(`opencode-translate/<version>`). If Anthropic rejects such requests
(401/403/blocked response), the error is surfaced through the normal
§6.4 failure surfaces (`INBOUND_TRANSLATION_FAILED` or the outbound
failure trailer); users can switch `translatorModel` to an API-key
provider or configure `options.apiKey`.

#### 6.3.3 Multi-var providers

If the resolved `Provider` has `p.key === undefined` and
`p.env.length > 1`, the plugin does **not** attempt to read or construct
credentials. It passes no `apiKey` to the factory and lets the
underlying `@ai-sdk/*` package read its own canonical env vars (e.g.
`@ai-sdk/amazon-bedrock` reads `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; `@ai-sdk/google-vertex`
reads `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`,
`GOOGLE_VERTEX_API_KEY`).

The plugin never calls `client.auth.set` for multi-var providers.
Credentials stored in `auth.json` for providers like `cloudflare`
(`{type:"api", key, metadata: { accountId, gatewayId }}`) are ignored by
the translator; users of those providers must set equivalent env vars or
switch to a single-var `translatorModel`. This is listed as a v1
non-goal in §2.

#### 6.3.4 Sentinel detection

The string `"opencode-oauth-dummy-key"` is defined as `OAUTH_DUMMY_KEY`
in `packages/opencode/src/auth/index.ts:7` and is what opencode returns
as `provider.key` when a provider is OAuth-backed via a plugin loader.
Any resolver branch that reads `p.key` **must** treat this exact value
as "no key" and fall through, even if `p.source` is not `"custom"`.
Empty string is treated the same way.

#### 6.3.5 Legal / ToS notice

Anthropic OAuth reuse depends on an undocumented token endpoint
(`console.anthropic.com/v1/oauth/token`), an undocumented beta header
(`anthropic-beta: oauth-2025-04-20`), and a hardcoded `client_id`
(`9d1c250a-e61b-44d9-88ed-5944d1962f5e`, registered by Anthropic for
their own `claude_cli`). Upstream opencode **removed** this flow in
commit `1ac1a0287` ("anthropic legal requests"); the historical
`opencode-anthropic-auth@0.0.13` npm package is deprecated
("Package no longer supported").

Enabling `opencode-translate` with Anthropic OAuth credentials means the
translator will attempt to reuse those tokens. Anthropic may fingerprint
and rate-limit or ban such traffic. The plugin does not reimplement the
evasions opencode removed; it issues requests with its own User-Agent
and without the tool-name rewriting or system-prompt substitution.
Users who do not want to accept this risk should either (a) configure a
plain API key via `ANTHROPIC_API_KEY` or `opencode auth login anthropic
→ Manually enter API Key`, or (b) set `translatorModel` to a
non-Anthropic provider. The README repeats this warning prominently.

### 6.4 Retry policy

The plugin throws plain `Error` instances with exact, stable message
templates so callers can display or match them consistently.

| Condition | Exact thrown message |
| --- | --- |
| Fresh-message inbound translation fails after retries | `[opencode-translate:INBOUND_TRANSLATION_FAILED] Failed to translate user message from {sourceLanguage} to en: {reason}` |
| Historical translated message hash mismatch / cache missing in transform | `[opencode-translate:STALE_CACHE] A previously translated user message was edited. Resend the message or start a new session.` |
| Resolver finds no usable credential for the translator provider | `[opencode-translate:AUTH_UNAVAILABLE] No credential found for provider "{providerID}". Set {envVar} in the environment, run "opencode auth login {providerID}", or set options.apiKey in opencode.json.` |
| OAuth refresh fails after retries | `[opencode-translate:OAUTH_REFRESH_FAILED] Failed to refresh OAuth token for provider "{providerID}": {reason}. Re-authenticate with "opencode auth login {providerID}".` |

`{reason}` is the translator/provider error normalised as: first line
only, `trim()` applied, maximum 200 characters. `{envVar}` is the first
entry in the provider's `env: string[]` array (e.g. `ANTHROPIC_API_KEY`
for `anthropic`); if `env` is empty, the literal string `the provider's
API key env var` is substituted.

- Two retries with exponential backoff (500 ms → 1500 ms) on network
  errors and 5xx responses. This applies to both translator calls and
  OAuth refresh calls.
- A 429 retries once after `Retry-After`, or after 2 s if the header is
  missing.
- `AUTH_UNAVAILABLE` is produced on the first attempt to use a
  non-resolvable translator provider (typically the first `chat.message`
  hook fire); the plugin does not try to guess credentials by scanning
  `process.env` beyond what the `@ai-sdk/*` package already does. The
  exact error text above is stable and safe to string-match.
- `OAUTH_REFRESH_FAILED` is produced only when the plugin actively
  attempted a refresh and the endpoint returned non-2xx after retries,
  or the response body could not be parsed as the expected token JSON.
  It is not produced when refresh is unnecessary (token still valid).
- On final failure:
  - **Inbound** (in `chat.message`): **throw from the hook** with a
    structured error. Because `chat.message`'s mutations are persisted
    only after a normal return (§3.2), no partial state is saved. The
    plugin guarantees the exact thrown message above. Callers surface it
    differently:
    - `client.session.prompt(...)` and the synchronous
      `/session/{id}/prompt` route fail the request with that message.
    - `client.session.promptAsync(...)` and `/prompt_async` currently
      emit a later `Session.Event.Error` because the server route catches
      and republishes the failure (`session.ts:917-929`).
    The plugin does **not** guarantee a synthetic in-chat part or a
    session bus event for synchronous callers; it guarantees only the
    thrown message text.
  - **Inbound** (in `experimental.chat.messages.transform`): throw
    with the exact `STALE_CACHE` message above. Same transport caveat as
    the previous bullet applies.
  - **Outbound** (in `experimental.text.complete`): leave
    `output.text` unchanged and append the inline failure trailer
    using the active session nonce (§5.2). The user immediately sees
    the English response plus a small inline notice that the
    translation failed; the next turn's transform step will strip the
    trailer so the LLM sees an English-only history.
  - **Auth resolution** (any hook): throw the exact
    `AUTH_UNAVAILABLE` or `OAUTH_REFRESH_FAILED` message above using
    the same transport rules as the enclosing hook (throw from
    `chat.message` aborts the turn; throw from
    `experimental.chat.messages.transform` aborts before the LLM call;
    throw from `experimental.text.complete` is surfaced through the
    outbound failure trailer with `{reason}` set to the auth error's
    first line).

### 6.5 Caching

- **Key**: `lowercase hex sha256(UTF-8(part.text)).slice(0, 16)`, stored as
  `metadata.translate_source_hash`.
- **Location**: `metadata.translate_en` +
  `metadata.translate_source_hash` on the user text part. Written by
  `chat.message`; read by `experimental.chat.messages.transform`.
- **Invalidation**: transform compares the stored hash against the
  current `part.text` hash. A mismatch (edited historical user
  message) aborts the turn (§5.1, §6.4). v1 does **not** silently
  re-translate on cache miss from inside the transform hook, because:
  1. transform mutations are not persisted (§3.2), so any
     re-translated value would be thrown away after the turn,
     guaranteeing the miss happens again next turn — an expensive
     infinite re-translation loop.
  2. the right fix is for the user to resend the message (which
     re-enters `chat.message` and re-populates the cache) or to
     start a new session.

Editing *historical* messages in a translation-enabled session is
therefore unsupported in v1; see §16 for the v2 plan.

### 6.6 Parallelism & scope control

- The plugin only translates user-authored text parts — parts where
  `synthetic !== true` and `ignored !== true`. This excludes opencode's
  own synthetic parts (e.g. the compaction auto-continue marker at
  `compaction.ts:442`, which has `compaction_continue: true`) so
  internal English plumbing is never garbled by the translator.
- In steady state only the newest user message is uncached per turn;
  everything else hits the metadata cache. Translation calls are
  issued sequentially to preserve ordering and keep provider
  rate-limits predictable.
- The transform hook never makes network calls (§6.5), so it stays
  O(messages) cheap even in tool-heavy turns.

## 7. Content Protection

### 7.1 Protected spans

The protection engine is deterministic.

- It runs on the original source string before translation.
- It scans left-to-right.
- Extractors run in the exact priority order listed below.
- Matches are non-overlapping: once text is replaced by a placeholder,
  later extractors do not inspect inside it.
- Placeholder indices start at `0` and increment by extraction order,
  producing tokens of the exact form `⟦OCTX:{kind}:{index}⟧`.

Exact extractor order:

1. Fenced code blocks delimited by triple backticks or triple tildes.
2. Inline code delimited by single backticks.
3. URLs matching `http://`, `https://`, `ws://`, `wss://`, `file://`,
   or `mailto:`.
4. Absolute POSIX paths starting with `/`.
5. Absolute Windows paths matching `^[A-Za-z]:\\`.
6. Relative paths containing `/` or `\\` whose final segment ends in one
   of these exact extensions:
   `c`, `cc`, `cpp`, `css`, `go`, `h`, `hpp`, `html`, `ini`, `java`,
   `js`, `json`, `jsx`, `kt`, `md`, `py`, `rs`, `sh`, `sql`, `swift`,
   `toml`, `ts`, `tsx`, `xml`, `yaml`, `yml`, `zsh`.
7. Environment-variable references matching `$NAME`, `${NAME}`, or
   `%NAME%` where `NAME` is `[A-Z_][A-Z0-9_]*`.
8. Stack-trace frames matching a JS-style line beginning with `at ` or
   `    at ` and containing a `path:line:column` suffix.
9. Unified-diff hunks: lines beginning with `@@ `, `+++ `, `--- `,
   `+`, or `-` when part of a contiguous diff block.
10. JSON / YAML keys: a quoted or bare token immediately followed by `:`
   at the start of a line or after indentation.
11. XML / HTML tags matching `<...>` on a single line.
12. Prompt-control markers matching `<!-- oc-translate:` literally, plus
   the single consumed activation keyword occurrence if one was stripped
   on this turn.
13. `@mentions`, `#issue` references, and git refs matching
   `[0-9a-f]{7,40}`.
14. Bare identifiers in one of these exact forms, length ≥ 3:
   `camelCase`, `PascalCase`, `snake_case`, `kebab-case`,
   `SCREAMING_SNAKE_CASE`.

Short shell flags are protected only inside fenced shell blocks from item
1. There is **no** free-text shell-flag extractor in v1.

After the translator returns, the plugin **restores** every placeholder
by exact string replacement. Any unresolved placeholder, duplicated
placeholder, or hallucinated new placeholder is treated as a protection
violation.

### 7.2 Prompt layout

```
System: You are a senior translator. Translate
from {SOURCE_LANG} to {TARGET_LANG}.

Hard rules:
 1. Tokens of the form ⟦OCTX:…⟧ are opaque placeholders. Copy them
    verbatim into the output, in the same order. Never translate,
    split, merge, or paraphrase them.
 2. Preserve markdown structure exactly (headings, list markers,
    table pipes, block quotes, horizontal rules).
 3. If the input is already in {TARGET_LANG}, return it unchanged.
 4. Output only the translation. No commentary, no preamble, no code
    fences around the whole response.

Examples:
  <<few-shot KO→EN example with protected placeholders>>
  <<few-shot EN→KO example with protected placeholders>>

User: <input with placeholders>
```

### 7.3 Post-check

After each translation the plugin verifies:

- Every `⟦OCTX:…⟧` placeholder emitted by the pre-check is present
  exactly once in the translator output; no extra placeholders were
  hallucinated.
- Fenced code-block count is identical before and after (defence in
  depth — the placeholder step should already guarantee this).
- URL and file-path counts (from the pre-check inventory) match.

On failure the plugin retries once with a stricter prompt
("Placeholders ⟦OCTX:…⟧ must appear verbatim. Your previous output
omitted {list}. Emit the full translation with every placeholder
restored."). A second failure surfaces through the §6.4 retry/abort
policy.

## 8. Configuration

Via `opencode.json`:

```json
{
  "plugin": [
    ["opencode-translate", {
      "translatorModel": "anthropic/claude-haiku-4-5",
      "triggerKeywords": ["$en"],
      "sourceLanguage": "ko",
      "displayLanguage": "ko",
      "verbose": false
    }]
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `translatorModel` | string | `"anthropic/claude-haiku-4-5"` | Translator model id in `provider/model-id` form understood by `ai`'s provider resolver. |
| `triggerKeywords` | string[] | `["$en"]` | Tokens whose presence in the first user message of a root session activates translation mode. Matched as whitespace-separated tokens; case-sensitive. |
| `sourceLanguage` | string | `"en"` | The language the user types in. ISO-639-1 preferred (`ko`, `ja`, `zh`, `de`, …). When equal to `"en"`, the **inbound** translation step is a no-op. |
| `displayLanguage` | string | `"en"` | The language the plugin renders assistant output in. When equal to `"en"`, the **outbound** translation step is a no-op. |
| `apiKey` | string | `undefined` | Optional. When set, used verbatim as the translator provider's `apiKey` and takes precedence over opencode's stored auth and env vars (§6.3.1). Intended for users who want the translator to use a different credential than the main chat. |
| `verbose` | boolean | `false` | When `true`, logs translation stats via `client.app.log` (visible with `opencode --log-level debug`). |

The LLM-facing language is fixed to English in v1.

**Credential resolution.** Credentials are resolved per §6.3; users
typically need do nothing beyond the standard `opencode auth login
<provider>` flow or setting the provider's canonical env var. `apiKey`
is provided as an escape hatch and is not required for the common case.

Degenerate configurations:

- `sourceLanguage === "en"` and `displayLanguage === "en"` → plugin is
  a full no-op; activation still works but translates nothing.
- `sourceLanguage === displayLanguage !== "en"` → the common
  Korean↔English shape.
- `sourceLanguage !== displayLanguage` (e.g. user writes Japanese, wants
  to read Korean) is supported; both legs run on every turn.

## 9. Translation Targets Matrix

| Content | Translated? | Notes |
| --- | --- | --- |
| User-authored text parts (`synthetic !== true`, `ignored !== true`) | Yes (source → English) | Cached in `metadata.translate_en` + `translate_source_hash`. |
| Synthetic user text parts (opencode's compaction auto-continue, our banner/preview, etc.) | No | Skipped in §6.6 to avoid corrupting internal English plumbing. |
| All assistant text parts | Yes (English → `displayLanguage`) | Every `text-end`. Rendered as dual-language with a nonce-scoped marker pair. |
| Reasoning parts | No | Collapsed in UI; translating adds cost without benefit. |
| Session title | **No, and not forced English in v1** | Path bypasses transform (§3.7, §5.3). Candidate for v2. |
| Compaction LLM input | Yes (via transform at `compaction.ts:303`) | Compaction model sees English. |
| Compaction summary *storage* part | No | Stays English in v1; inherited by subsequent turns. |
| Tool names / inputs / outputs | No | Internal plumbing; paths and commands are English. |
| Subagent (task) internal messages | No | Session has `parentID`; plugin returns early (§4.5). |

## 10. User Experience Details

### 10.1 Input display

- The user's original message is shown exactly as typed; the source
  language stays in the source language in the UI and in storage.
- Directly below the user message, a plugin-owned text part shows
  `→ EN: <translated>` with
  `synthetic: true, ignored: true,
  metadata.translate_role: "translation_preview"`. It is visible in
  the UI and excluded from the LLM context because the user-side
  serialiser (`message-v2.ts:773`) skips `ignored:true` text parts.

### 10.2 Output display

During streaming the LLM's English text renders live. When each text
part completes, its stored `text` is rewritten to:

```
<original English text>

<!-- oc-translate:{nonce}:start -->
---

**{displayLanguageLabel}:**

<translated text>
<!-- oc-translate:{nonce}:end -->
```

`{displayLanguageLabel}` is chosen from this exact mapping table:

| `displayLanguage` | Label |
| --- | --- |
| `en` | `English translation` |
| `ko` | `한국어 번역` |
| `ja` | `日本語訳` |
| `zh` | `中文翻译` |
| `zh-CN` | `简体中文翻译` |
| `zh-TW` | `繁體中文翻譯` |
| `de` | `Deutsche Übersetzung` |
| `fr` | `Traduction française` |
| `es` | `Traducción al español` |

Any other code falls back to the exact string
`Translation (<displayLanguage>)`.

### 10.3 Activation banner

On the very first turn of a translation-enabled session, the
plugin-owned activation banner appears before the main LLM response:

```
✓ Translation mode enabled · translator: claude-haiku-4-5 · source: ko · display: ko
```

### 10.4 Failure surfaces

- **Inbound failure (fresh message)**: the `chat.message` hook throws
  the exact `INBOUND_TRANSLATION_FAILED` string from §6.4; the turn does
  not proceed to the LLM; nothing from that turn is persisted (§3.2).
  Sync callers see a failed request. Async callers currently surface the
  same message through `Session.Event.Error` because the server catches
  and republishes it.
- **Inbound failure (stale cache on historical message)**: transform
  throws the exact `STALE_CACHE` string from §6.4. Same caller-dependent
  transport as above.
- **Outbound failure**: English is left visible (already streamed) and
  the plugin appends the inline failure trailer (§5.2) so the user
  sees `_Translation unavailable for this segment._` directly under
  the English. The trailer is stripped on the next turn's transform
  so history remains English-only.
- **Missing translator credential (`AUTH_UNAVAILABLE`)**: the plugin
  throws the exact `AUTH_UNAVAILABLE` string from §6.4 on the first
  translator call. The throw happens from whichever hook first needed
  credentials (typically `chat.message` during inbound translation);
  transport follows that hook's throw semantics. The message includes
  the canonical env var name and the exact `opencode auth login`
  command, so the user can correct the setup without reading the spec.
- **OAuth refresh failure (`OAUTH_REFRESH_FAILED`)**: surfaces through
  the enclosing hook's transport, just like a translator error. The
  message instructs the user to re-run `opencode auth login
  <providerID>` to mint a fresh refresh token. The plugin does not
  attempt to re-authorize silently.

## 11. Error Handling Summary

| Stage | Failure | Behaviour |
| --- | --- | --- |
| Inbound translation (`chat.message`) | Network / 5xx / 429 | 2 retries with backoff; final failure throws exact `INBOUND_TRANSLATION_FAILED`; turn aborted; nothing persisted. Transport is sync-request failure or async `Session.Event.Error` depending on caller path. |
| Inbound translation (`chat.message`) | Placeholder post-check fails twice | Same as above. |
| Inbound transform (`experimental.chat.messages.transform`) | Cache miss or hash mismatch on historical message | Throw exact `STALE_CACHE`; turn aborted. Transport is sync-request failure or async `Session.Event.Error` depending on caller path. |
| Outbound translation (`experimental.text.complete`) | Any failure | Leaves English visible; appends inline failure trailer with active nonce; no next-turn synthetic warning is needed because the user already sees it inline. |
| Credential resolution (any hook) | No usable `apiKey` / `fetch` for translator provider | Throw exact `AUTH_UNAVAILABLE`; turn aborted at the enclosing hook's throw site. Transport follows the enclosing hook's rules. |
| OAuth refresh (any hook) | Refresh endpoint returned non-2xx after retries, or response not parseable | Throw exact `OAUTH_REFRESH_FAILED`; turn aborted at the enclosing hook's throw site. Refreshed tokens from prior successful refreshes remain persisted via `client.auth.set`. |

## 12. Telemetry & Logging

- `verbose: false` (default) — quiet happy path; only failures are
  logged.
- `verbose: true` — one log line per translation call via
  `client.app.log({ body: { service: "opencode-translate",
  level: "info", message: "translated",
  extra: { direction, chars_in, chars_out, ms, cached, model } } })`.

**Privacy.** Enabling this plugin means the session's user and
assistant text traverses **two external LLM providers** per turn: the
main-chat provider configured in opencode *and* the `translatorModel`
provider configured here. For users with strict data-residency or
self-hosted-only constraints, this is a material change from running
opencode without the plugin. The README calls this out explicitly. The
plugin itself does not send data anywhere other than to the configured
`translatorModel` provider.

## 13. Package Layout

Closely mirrors `opencode-md-table-formatter` and `opencode-vibeguard`
so the plugin drops into the existing ecosystem without extra build
orchestration.

```
opencode-translate/
├── src/
│   ├── index.ts          # default named export; hook wiring
│   ├── activation.ts     # keyword detection, metadata state
│   │                     # read/write, session-nonce minting,
│   │                     # subagent detection
│   ├── translator.ts     # ai.generateText wrapper, retry, hash cache
│   ├── auth.ts           # credential resolution (§6.3.1),
│   │                     # auth.json reader honouring OPENCODE_AUTH_CONTENT,
│   │                     # OAuth refresh + custom fetch factories for
│   │                     # anthropic / openai (codex) / github-copilot
│   ├── protect.ts        # placeholder-based pre/post protection
│   ├── prompts.ts        # system prompt template + few-shot fixtures
│   ├── formatting.ts     # dual-language compose/extract helpers
│   │                     # (nonce-scoped markers)
│   ├── labels.ts         # per-language display labels
│   └── constants.ts
├── test/
│   ├── activation.test.ts
│   ├── translator.test.ts    # cache + retry + protect, mocked
│   ├── auth.test.ts          # priority order, OAuth refresh, sentinel
│   ├── protect.test.ts
│   ├── formatting.test.ts
│   └── labels.test.ts
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

No compiled `dist/` — opencode's plugin loader runs `.ts` directly
under Bun, the same way `opencode-md-table-formatter` does it.

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
# "plugin": [["opencode-translate", {
#   "sourceLanguage": "ko", "displayLanguage": "ko"
# }]]

# make sure the translator provider has credentials. Either:
#   a) opencode auth login anthropic    (recommended; shared with opencode)
#   b) export ANTHROPIC_API_KEY=sk-ant-...
# Both work; the plugin resolves per §6.3.1.

opencode    # first message in a new session begins with "$en"
```

## 14. Testing Strategy

All automated tests are pure-logic with the translator mocked.
Integration with a real provider is documented as a manual smoke test
in the README and requires an `ANTHROPIC_API_KEY`.

### 14.1 Unit tests

- **`activation.test.ts`**
  - Keyword detection at start, middle, end of part text.
  - Keyword stripping preserves whitespace cleanly.
  - Exact stripping examples are locked:
    - `$en hello` → `hello`
    - `hello $en world` → `hello world`
    - `hello\n$en world` → `hello\nworld`
    - `hello $en\nworld` → `hello\nworld`
    - `literal $en and trigger $en` removes only the first matching
      occurrence selected by §5.1 and leaves the second untouched.
  - Multiple keywords (`["$en", "$tr"]`) match as disjunction.
  - First-message-only: keyword in second message does not activate.
  - Child session (non-null `parentID` on the session returned by
    `client.session.get`) is detected and the plugin is a no-op.
  - Forked translated session inherits translation mode without a new
    trigger because copied metadata satisfies §4.4.
  - Forked untranslated session remains permanently inactive.
  - Metadata round-trip: write `translate_enabled`,
    `translate_source_lang`, `translate_display_lang`,
    `translate_nonce` to metadata on a fake `{message, parts}` output
    and read it back through both the banner anchor and the
    per-user-part fallback.
  - Multi-part ordering is exact: `[text,file,text]` on the activation
    turn becomes `[text,preview,file,text,preview,banner]`.
- **`translator.test.ts`**
  - Hash cache hit skips `generateText`.
  - Hash mismatch in transform hook throws the exact `STALE_CACHE`
    message and
    does NOT call `generateText`.
  - Synthetic user parts (`synthetic: true` or `ignored: true`) are
    skipped; in particular the compaction auto-continue marker
    (`metadata.compaction_continue === true`) is left untranslated.
  - Retry: 1 simulated transient failure then success.
  - Final failure after retries in `chat.message` throws (simulating
    hook-level abort) with the exact `INBOUND_TRANSLATION_FAILED`
    prefix; no part is emitted by the failing code path.
- **`protect.test.ts`**
  - Every placeholder kind (code blocks, paths, URLs, shell flags,
    env vars, JSON keys, stack frames, diff hunks, regex, HTML tags)
    round-trips.
  - A simulated translator that drops a placeholder triggers the
    stricter-retry path.
  - A simulated translator that hallucinates an extra placeholder is
    detected by the post-check.
- **`formatting.test.ts`**
  - Compose with nonce `N`:
    `<EN>\n\n<!-- oc-translate:N:start -->\n---\n\n**<lang>:**\n\n<KO>\n<!-- oc-translate:N:end -->`.
  - Extract: given a stored part with that trailer, recovering the EN
    half returns exactly `<EN>`.
  - Adversarial: an assistant response whose English half itself
    contains the literal string `<!-- oc-translate:OTHER:start -->`
    with a *different* nonce is NOT truncated.
  - Adversarial: an assistant response whose English half contains a
    stand-alone `---` horizontal rule is NOT truncated.
  - Failure trailer round-trip: compose-with-failure → extract returns
    exactly `<EN>` for the LLM history, and the UI-visible text
    contains the `_Translation unavailable for this segment._`
    notice.
  - Parser strictness: malformed trailers, trailers with trailing
    non-empty lines after the end marker, or mismatched nonces are
    treated as plain English and are NOT trimmed.
  - Compose → extract → compose is stable.
 - **`labels.test.ts`**
  - Exact mapping table for `en`, `ko`, `ja`, `zh`, `zh-CN`, `zh-TW`,
    `de`, `fr`, `es`.
  - Unknown code falls back to `Translation (<displayLanguage>)`.
- **`auth.test.ts`**
  - Priority order: a plugin `options.apiKey` beats an `api`-source
    `provider.key` from a mocked `client.provider.list()`.
  - `api`-source `provider.key` beats `env`-source `provider.key`
    (though in practice the mocked list would only emit one source per
    provider; this test asserts the resolver does not mis-interpret
    source labels).
  - `env`-source `provider.key` is used when present.
  - `provider.key === "opencode-oauth-dummy-key"` is treated as "no
    key" even when `source === "env"` or `source === "api"`; resolver
    falls through.
  - `provider.key === ""` is treated the same.
  - `provider.key === undefined` with `provider.env.length > 1`
    produces a factory without `apiKey`, and that factory's own env-var
    discovery is not mocked away.
  - `OPENCODE_AUTH_CONTENT` override: when set to a JSON string with
    `{"anthropic":{"type":"oauth", ...}}`, the OAuth branch reads it
    instead of touching the filesystem.
  - OAuth refresh: a fresh token (`expires > Date.now() + 60_000`)
    skips the refresh endpoint; an expired token triggers one refresh
    call; the response is persisted via a mocked
    `client.auth.set({ path: { id: "anthropic" }, body: {...} })`.
  - OAuth refresh is coalesced: two concurrent `resolveOAuth("anthropic")`
    calls during refresh produce exactly one network call to the token
    endpoint.
  - OAuth refresh failure throws the exact `OAUTH_REFRESH_FAILED`
    message after 2 retries; the retry count matches the translator's
    retry policy.
  - OAuth request headers: a mocked `fetch` assertion confirms
    `Authorization: Bearer <access>`, the required `anthropic-beta`
    header (containing `oauth-2025-04-20`), `anthropic-version:
    2023-06-01`, absence of `x-api-key`, and presence of `?beta=true`
    for `/v1/messages`.
  - The plugin does **not** emit the User-Agent `claude-cli/...` or the
    tool-name `mcp_` prefix that opencode removed; assertions catch any
    regression.
  - Missing credential path produces the exact `AUTH_UNAVAILABLE`
    message with `{providerID}` and `{envVar}` substituted correctly
    from the mocked `provider.env[0]`. Empty `env` array falls back to
    `the provider's API key env var` literal.
  - Provider-list fetch failure (SDK error) does not throw
    `AUTH_UNAVAILABLE`; the resolver instead falls through to step 3
    (ai-sdk default) and only surfaces an auth error if that also fails.

### 14.2 Manual smoke test (documented in README)

1. Install the plugin globally.
2. Add it to `~/.config/opencode/opencode.json` with
   `sourceLanguage: "ko"`, `displayLanguage: "ko"`.
3. Start a new session with:
   `$en 프로젝트 루트의 package.json을 읽고 요약해줘`.
4. Confirm:
   - Plugin-owned activation banner appears.
   - Plugin-owned `→ EN: …` preview appears under the user message.
   - LLM response streams in English.
   - After each text part finishes, a Korean translation appears below
     a markdown divider flanked by nonce-scoped HTML comments.
   - Subsequent messages without `$en` also translate in both
     directions.
   - Editing a historical user message in this session and resubmitting
     produces a clear "stale translation cache" error rather than a
     silent mistranslation.
   - No `$en` on message 1 → plugin is a no-op for the session.
   - Launching a `task` tool subagent does not translate anything in
     the child session.
   - The session title appears in the source language (known v1
     limitation, §5.3).

## 15. Implementation Milestones

1. Repo scaffolding: `package.json`, `tsconfig.json`, `.gitignore`,
   empty plugin entry.
2. `translator.ts` + `prompts.ts` — core `ai.generateText` wrapper
   with retries and few-shot prompt.
3. `protect.ts` — placeholder-based preservation.
4. `activation.ts` — keyword detection, session-nonce mint,
   subagent detection, banner and per-part metadata.
5. `formatting.ts` — compose/extract helpers for the nonce-scoped
   divider scheme.
6. `chat.message` hook — activation + inbound translation + banner +
   preview + throw-on-failure semantics.
7. `experimental.chat.messages.transform` hook — cache-only lookup +
   EN extraction for assistant parts + hash-mismatch abort.
8. `experimental.text.complete` hook — outbound translation +
   dual-language composition + inline failure trailer.
9. Unit tests.
10. README + examples (including the explicit privacy note).
11. Manual smoke test.
12. GitHub Action publishing to npm on `v*` tag pushes.

## 16. Open Questions / Possible v2 Extensions

- **Title translation / enforcement.** Requires either an upstream
  hook (e.g. `experimental.session.title`) so the title-generation
  LLM call flows through a plugin, or a post-hoc rewrite of
  `session.title` via `client.session.update` on `session.updated`
  with a loop-avoidance marker.
- **Compaction summary part translation for display** once the
  summariser produces English (v1 already ensures this). Low-lift v2
  follow-up: translate the stored `compaction` part text via a
  post-hoc path or new hook.
- **TUI companion plugin** for a status-bar translation indicator.
- **`$raw` single-message escape** to send one message untranslated
  without disabling the session.
- **User glossary** (`{ en: "session", target: "세션" }`) for domain
  vocabulary.
- **Auto-detected source language** with a fallback when the user
  types English inside a non-English session.
- **"Only-final-text-part" output translation** if opencode core
  grows a message-complete hook (e.g.
  `experimental.message.complete`).
- **Self-healing edited historical user messages**: requires either
  a durable part-update SDK endpoint or a dedicated edit hook so the
  plugin can refresh the per-part cache instead of aborting the
  turn.

None of these block v1.

## 17. Corrections Applied Relative to Prior Drafts

Draft v2 of the spec contained several design issues that surfaced
only after a second read of the opencode source. Keeping a changelog
inline makes future re-reads faster.

- **`chat.message` throw-vs-synthetic-part corrected.** v2 claimed the
  plugin pushes a synthetic "translation failed" error part and then
  throws from the hook. The core only persists `output.parts` after a
  *normal* return (§3.2), so that combination would have swallowed
  the error message. v3 switches to throwing cleanly and surfacing
  through `Session.Event.Error`.
- **Language model split.** `targetLanguage` conflated "user types"
  and "user reads". v3 splits into `sourceLanguage` and
  `displayLanguage` (plus a fixed `llmLanguage = "en"`), renames
  `metadata.translate_user_lang` → `metadata.translate_source_lang`,
  and adds `metadata.translate_display_lang`.
- **Nonce-scoped assistant divider.** v2 used a fixed literal
  `<!-- opencode-translate:divider -->` which a model could
  legitimately emit. v3 uses
  `<!-- oc-translate:{nonce}:start -->` / `:end` markers derived
  from a per-session nonce, with the transform step only honouring
  the active nonce.
- **Transform hook is now cache-only.** v2 allowed on-the-fly
  re-translation inside `experimental.chat.messages.transform`.
  Because transform mutations are not persisted, this risked an
  infinite re-translation loop on every turn. v3 makes transform a
  pure cache lookup and aborts the turn on hash mismatch.
- **Privacy wording corrected.** v2 claimed "no data is ever
  transmitted anywhere except the configured translator provider",
  which was misleading — data also goes to the main-chat provider as
  before. v3's §12 is explicit about dual-provider exposure.
- **Placeholder-based protection** replaces "prompt the translator
  nicely" for code blocks, paths, and URLs, and adds shell flags,
  env vars, JSON keys, stack frames, diff hunks, regex literals,
  and HTML/XML tags.
- **Subagent detection** is now grounded in `Session.parentID`
  (verified against `client.session.get`'s schema at
  `packages/sdk/js/src/v2/gen/types.gen.ts:933-940`), not an abstract
  notion of "subagent context".
- **Compaction scope clarified.** The compaction summariser *does*
  call `experimental.chat.messages.transform`
  (`compaction.ts:303`), so the compaction LLM sees English in v1.
  v2 had deferred this unnecessarily.
- **Title scope clarified (as a limitation).** The title path
  *does not* call transform (`prompt.ts:186-200`), so v1 cannot
  force the title LLM call to English. This is now an explicit
  non-goal.
- **Activation anchor moved** from "first user message's first text
  part" to a plugin-owned banner part, with metadata duplicated onto
  every translated user text part for resilience.
- **Caller-dependent error transport clarified.** v3 still read as if a
  thrown `chat.message` failure always became a visible
  `Session.Event.Error`. v4 distinguishes synchronous request failure
  from async `prompt_async` re-publication and only guarantees the exact
  thrown message text.
- **First-message and fork semantics locked.** v4 defines activation as:
  valid stored translation metadata wins; otherwise only an empty root
  session may activate. Forked sessions intentionally inherit the source
  session's translation state because `session.fork` clones part
  metadata.
- **SDK examples corrected.** v3 mixed raw HTTP route shape with SDK call
  shape; v4 uses the JS SDK argument shape consistently.
- **Trigger stripping, part ordering, and trailer parsing made exact.**
  v4 fixes the matching order, replacement rules, synthetic-part
  insertion order, and the assistant trailer parser so independent
  implementations converge.
- **Protection tokenizer and label table made deterministic.** v4 adds a
  fixed extractor priority order, exact relative-path extension list,
  and an exact `displayLanguageLabel` mapping table.
- **Credential sharing with opencode auth promoted to v1 (§6.3).** v4
  scoped auth sharing out of v1 (env vars only). v5 reads credentials
  from opencode's stored auth via `client.provider.list()` and, for
  OAuth-backed providers (`anthropic`, `openai` / Codex,
  `github-copilot`), reconstructs the refresh + custom-fetch flow
  directly from `auth.json`. Priority order: `options.apiKey` →
  opencode stored auth → env var (ai-sdk default fallback). OAuth
  refresh is coalesced per providerID to avoid the refresh-token race
  inherent in opencode's own plugins, and refreshed tokens are persisted
  back via `client.auth.set` to keep opencode and the plugin in sync.
  Multi-var providers (Bedrock, Vertex, Cloudflare) are listed as a v1
  non-goal: the translator delegates to each `@ai-sdk/*` package's own
  env-var discovery for those.
- **Legal/ToS acknowledgement for Anthropic OAuth (§6.3.5).** v5
  explicitly notes that upstream opencode removed Anthropic OAuth in
  commit `1ac1a0287` ("anthropic legal requests") and that the
  `opencode-anthropic-auth@0.0.13` npm package is deprecated. The
  plugin reuses Anthropic OAuth tokens when present but does not
  reintroduce the evasions opencode removed (User-Agent spoof,
  tool-name `mcp_` prefix rewriting, system-prompt text substitution).
  Users who enable the plugin with Anthropic OAuth credentials accept
  the risk that Anthropic may rate-limit or block such traffic.
- **Two new error templates (§6.4).** `AUTH_UNAVAILABLE` and
  `OAUTH_REFRESH_FAILED` are added with exact, stable messages that
  include actionable remediation (env var name and `opencode auth
  login` command).
- **New `apiKey` config option (§8).** Optional plugin override that
  beats both opencode stored auth and env vars. Supports users who want
  the translator to use a different credential from the main chat
  provider.
- **New `src/auth.ts` module and `auth.test.ts` suite (§13, §14.1).**
  Isolates credential resolution, OAuth refresh coalescing, and custom
  fetch construction from the rest of the plugin so translator logic
  remains transport-agnostic.

## 18. Source Interview Summary (for future contributors)

This spec is the output of a design interview plus review passes.
Decisions taken, in order:

1. Activation: first-message keyword → whole-session ON.
2. Storage: keep user's original text, translate to English per turn
   with caching.
3. Translator: dedicated cheap model (default Haiku) configurable via
   `translatorModel`.
4. Protect: placeholder-based for code blocks, inline code, file
   paths, URLs, identifiers, shell, env, JSON keys, stack frames,
   diffs, regex, tags.
5. Streaming UX: stream English live, append the display-language
   translation inside a nonce-scoped marker pair when each text part
   finishes.
6. Input display: show the English preview as a plugin-owned part
   beneath the user's original.
7. Deactivation: none in v1.
8. Failure handling: 2 retries; inbound final failure throws from the
   hook (no synthetic error part); outbound failure emits an inline
   failure trailer.
9. Reasoning: not translated.
10. Title: **cannot be forced to English in v1**; deferred.
11. Compaction: LLM sees English in v1 (inherits transform); stored
    summary stays English.
12. Subagents: not translated; detected via `session.parentID`.
13. Distribution: public npm package under `ysm-dev`'s GitHub org.
14. Activation state: plugin-owned banner part (canonical) +
    per-user-part metadata (fallback).
15. Source and display languages: both configured by the user
    (`sourceLanguage`, `displayLanguage`); LLM language fixed to
    English.
16. Translator call: direct `ai.generateText`, not SDK prompt.
17. Empty/code-only messages: still translated if prefix present
    (with placeholder protection doing most of the work).
18. "Only translate the last answer" preference: acknowledged but
    technically infeasible with today's hook surface (§3.3); every
    text part is translated in v1.
19. Activation announcement: a plugin-owned banner part.
20. Config options: `translatorModel`, `triggerKeywords`,
    `sourceLanguage`, `displayLanguage`, `verbose`.
21. Translator prompt: strong instructions + 2 few-shots +
    placeholder rule.
22. Tests: pure-logic only, translator mocked.
23. Debug: errors always; verbose flag for happy-path telemetry.
24. Historical edits: unsupported in v1; transform aborts the turn
    on hash mismatch.
25. Credential sharing with opencode auth: in v1 the translator shares
    credentials with opencode's stored auth (`auth.json` via
    `client.provider.list()` for api/env sources; direct file read
    honouring `OPENCODE_AUTH_CONTENT` for OAuth records). OAuth reuse
    is always on for `anthropic`, `openai` (Codex), and
    `github-copilot`. Priority order is `options.apiKey` → opencode
    stored auth → env var. No config toggle; legal/ToS risk for
    Anthropic OAuth is documented in §6.3.5.

## 19. References

- OpenCode plugin docs: https://opencode.ai/docs/plugins/
- OpenCode SDK docs: https://opencode.ai/docs/sdk/
- Plugin API types:
  `packages/plugin/src/index.ts` (Hooks, Plugin, PluginInput,
  PluginOptions, PluginModule).
- Hook dispatch sites (all verified against the local checkout at
  `/Users/chris/git/opencode`):
  - `chat.message`: `packages/opencode/src/session/prompt.ts:1234`
  - `experimental.chat.messages.transform` (main loop):
    `packages/opencode/src/session/prompt.ts:1471`
  - `experimental.chat.messages.transform` (compaction):
    `packages/opencode/src/session/compaction.ts:303`
  - `experimental.text.complete`:
    `packages/opencode/src/session/processor.ts:436`
  - Title path (does **not** call transform):
    `packages/opencode/src/session/prompt.ts:157-217`
  - `event` (firehose): `packages/opencode/src/plugin/index.ts:244`
- Part schema: `packages/opencode/src/session/message-v2.ts:106-122`
  (TextPart), with user-side `ignored` filter at line 773 and
  assistant-side serialiser starting at line 828.
- Session schema (`parentID` etc.):
  `packages/sdk/js/src/v2/gen/types.gen.ts:933-940`.
- Session `update` permitted fields:
  `packages/sdk/js/src/v2/gen/types.gen.ts:3405-3421` (only `title`,
  `permission`, `time.archived`).
- Subagent session creation (sets `parentID`):
  `packages/opencode/src/tool/task.ts:67-71`.
- Compaction auto-continue marker (internal English plumbing to skip
  on translation): `packages/opencode/src/session/compaction.ts:442`.
- ID helpers (for generating synthetic part IDs):
  `packages/opencode/src/id/id.ts` — prefix `prt_`.
- Reference plugins:
  - https://github.com/franlol/opencode-md-table-formatter (uses
    `experimental.text.complete` only; closest shape to ours).
  - https://github.com/inkdust2021/opencode-vibeguard (combines
    `experimental.chat.messages.transform` +
    `experimental.text.complete`; directly parallels our
    inbound/outbound split).
  - Internal: `packages/opencode/src/plugin/codex.ts`,
    `cloudflare.ts`, `github-copilot/copilot.ts` — canonical
    examples of registering hooks, reading via the SDK, and using
    `chat.params`/`chat.headers`.
- Auth / credential resolution (all referenced from §6.3):
  - `packages/opencode/src/auth/index.ts:7` — `OAUTH_DUMMY_KEY`
    constant (`"opencode-oauth-dummy-key"`).
  - `packages/opencode/src/auth/index.ts:9` — `auth.json` file path
    (`path.join(Global.Path.data, "auth.json")`, mode 0o600).
  - `packages/opencode/src/auth/index.ts:13-36` — `Auth.Info`
    discriminated union (`api` / `oauth` / `wellknown`).
  - `packages/opencode/src/auth/index.ts:59-63` —
    `OPENCODE_AUTH_CONTENT` env-override loader.
  - `packages/opencode/src/global/index.ts:10-20` — `Global.Path.data`
    via `xdg-basedir`.
  - `packages/opencode/src/provider/provider.ts:1212-1276` —
    credential priority resolution (env → auth.json → plugin auth
    loader → custom loader).
  - `packages/opencode/src/provider/provider.ts:894-905` —
    `Provider.Info` schema with `id`, `source`, `env`, `key`,
    `options`, `models`.
  - `packages/opencode/src/plugin/codex.ts:417-433` — Codex OAuth
    refresh pattern (reference for §6.3.2 refresh semantics, minus the
    race-condition bug we fix with promise coalescing).
  - `packages/opencode/src/plugin/github-copilot/copilot.ts:57-171` —
    Copilot token-exchange pattern.
  - `packages/sdk/js/src/gen/sdk.gen.ts:753-762` — v1 SDK
    `client.provider.list()` (`GET /provider`).
  - `packages/sdk/js/src/gen/sdk.gen.ts:916-925` — v1 SDK
    `client.auth.set()` (`PUT /auth/{id}`).
  - `packages/sdk/js/src/gen/types.gen.ts:1514-1526` — `Provider`
    response type (`key?: string`, `source: "env"|"config"|"custom"|"api"`).
  - Upstream removal of Anthropic OAuth: opencode commit `1ac1a0287`
    ("anthropic legal requests"); the deprecated
    `opencode-anthropic-auth@0.0.13` npm package preserves the flow
    shape referenced in §6.3.2.
