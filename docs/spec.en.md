# `opencode-translate` — Specification

> Status: Draft v1 · Owner: [@ysm-dev](https://github.com/ysm-dev)
> Target platform: [OpenCode](https://github.com/sst/opencode) plugin
> Plugin API: `@opencode-ai/plugin`

---

## 1. Goal

Allow an OpenCode user to converse **in any language they prefer** while every outbound LLM API call is made **in English only**. The plugin is a translation proxy that:

1. Translates each user message from the user's native language to English before it reaches the main LLM.
2. Keeps the main LLM fully English-only (system prompt, history, tool I/O).
3. Translates the main LLM's English response back into the user's native language for display.
4. Stays session-scoped: activation happens once per session via a prefix keyword (`$en`) on the first user message, then the behaviour applies to every subsequent message of that session.

The user can type in Korean (or any language); the LLM sees English; the user reads the reply in their configured display language.

## 2. Non-Goals (v1)

- No mid-session toggle (`$raw`, `$en off`, `/translate off`). Activation is sticky until the session ends.
- No auto-detection of the user's display language. The user configures it once in `opencode.json`.
- No TUI plugin companion / status-bar widget. Feedback is delivered purely via synthetic message parts.
- No translation of tool names, tool arguments, or tool output.
- No translation of reasoning ("thinking") parts.
- No translation inside subagent (task tool) conversations.
- No glossary / user dictionary support.

## 3. Trigger & Lifecycle

### 3.1 Activation

- The plugin inspects the **first user message** of each session inside the `chat.message` hook.
- If any text part of that message contains any configured `triggerKeywords` token (default `["$en"]`), the session is marked active.
- The keyword token is **stripped** from the text part before the message is saved, so the LLM never sees the raw keyword.
- An activation banner is pushed as a synthetic part:
  `✓ Translation mode enabled (model: <translator-model>, display: <targetLanguage>)`.

### 3.2 Session scope

- Once activated, the session is permanently in translation mode.
- There is no deactivation command. To write directly in English, start a new session without the prefix.

### 3.3 State persistence

- The active flag lives on the first user message's first text part:
  - `metadata.translate_enabled = true`
  - `metadata.translate_user_lang = "<targetLanguage>"`
  - `metadata.translate_llm_lang = "en"`
- Because message metadata is durable session storage, the flag survives server restart, session resume, and compaction. The plugin re-reads this on every hook invocation, so no in-memory state is required.

### 3.4 Subagents (task tool)

- When the `task` tool spawns a subagent session, that session is **not** translation-enabled. Task prompts are already written in English by the parent LLM, and the user never reads subagent internals directly. Only the subagent's returned summary, which flows back into the parent session's text stream, gets translated (as part of the normal last-text-part translation).

## 4. Hook Map

The plugin attaches the following hooks (all other hooks are untouched):

| Hook | Source location | Plugin responsibility |
| --- | --- | --- |
| `chat.message` | `packages/opencode/src/session/prompt.ts:1234` | Detect & strip trigger keyword on first message; mark session active; translate text parts source→English; cache translation in `part.metadata.translated_en`; push synthetic preview and activation banner parts. |
| `experimental.chat.messages.transform` | `packages/opencode/src/session/prompt.ts:1471` | Per-turn rebuild of the message list sent to the main LLM. For each user text part, substitute the cached English translation. For each assistant text part, strip the appended user-language translation so only the original English reaches the LLM. |
| `experimental.text.complete` | `packages/opencode/src/session/processor.ts:436` | **No-op** in v1 (returns `text` unchanged). The actual assistant translation is handled via the `event` hook so that only the *last* text part of a completed message is translated. |
| `event` (firehose) | `packages/opencode/src/plugin/index.ts:244` | Listen for `message.updated` / `session.idle` events. When an assistant message transitions to a completed state, locate its last text part and translate English→targetLanguage, then patch it via `client.session.updatePart`. Also listen for title updates and translate the session title. |
| `tool.execute.before`, `tool.execute.after`, `tool.definition` | — | **Not used.** Tools pass through untouched. |
| `experimental.chat.system.transform` | — | **Not used.** The main LLM's system prompt is left transparent. |

## 5. Data Flow

### 5.1 Inbound (user → LLM)

```
  User types (Korean, first message includes "$en")
               │
               ▼
  chat.message hook
    • Detect "$en" in first text part → strip it
    • Mark session: firstPart.metadata.translate_enabled = true
    • Push synthetic activation banner part
    • Translate Korean → English (ai.generateText)
    • Store translation on part.metadata.translated_en with text hash
    • Push synthetic "→ EN: ..." preview part (ignored:true, synthetic:true)
    • Save via sessions.updateMessage / updatePart (persisted)
               │
               ▼
  experimental.chat.messages.transform hook (every loop iteration)
    • For each user text part:
        - If metadata.translated_en exists AND hash(part.text) matches
          the stored hash → replace part.text with cached English.
        - Else translate now, cache via updatePart.
    • For each assistant text part:
        - If it contains the translation footer marker
          (see §5.2), strip everything after it so only the
          original English survives for the LLM.
               │
               ▼
  Main LLM receives English-only conversation
```

### 5.2 Outbound (LLM → user)

```
  Main LLM streams English text-delta events
    • UI renders English in real time (unchanged OpenCode behaviour)
               │
               ▼
  text-end fires for each text part
    • experimental.text.complete is a no-op (returns text unchanged)
               │
               ▼
  Tool calls may follow; more text parts may be created
               │
               ▼
  event hook observes message-completion
    ("message.updated" with completed state, or session.idle)
    • Find the last text part of the completed assistant message
    • Translate its English text → targetLanguage (ai.generateText)
    • Rewrite the part.text to:

        <original English>

        ---

        **<targetLanguage label>:**

        <translated text>

    • Cache: part.metadata.translated_<lang> = translated text
    • Cache: part.metadata.original_en = original English text
    • Patch via client.session.updatePart
               │
               ▼
  User sees English (streamed live) + translated section
  appended below a markdown divider
```

### 5.3 Session title

- OpenCode generates session titles via its own LLM call (separate from the main conversation).
- The plugin observes `session.updated` events. When a newly set title is English (i.e. when the session is translation-enabled), the plugin translates it to `targetLanguage` and writes it back via `client.session.update`.
- Rationale: the session list is the primary way users re-find work, and seeing an English label in a Korean UI hurts recall.

### 5.4 Compaction

- Compaction summaries are produced as ordinary text parts, so they flow through the same `experimental.chat.messages.transform` pipeline on subsequent turns (their English stays English when fed back to the LLM) and through the same last-text-part translation when displayed.
- No special-casing required.

## 6. Translation Engine

### 6.1 Library choice

- **`ai` npm package + provider SDK** (e.g. `@ai-sdk/anthropic`, `@ai-sdk/google`), using `generateText`.
- Not via the OpenCode SDK's scratch-session mechanism, which would leave stray sessions and pull the entire OpenCode loop into every translation call.
- Not via raw HTTP, which would require per-provider branching.

### 6.2 Default model

- `anthropic/claude-haiku-4-5` — cheap, fast, strong on code-adjacent text.
- Configurable via `model` in the plugin options.

### 6.3 Authentication

- The plugin reads provider API keys from the standard provider-specific environment variables (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.). The README lists the supported set.
- No attempt to share OpenCode's auth storage in v1 (keeps the plugin independent and easy to reason about).

### 6.4 Retry policy

- Two retries with exponential backoff (500 ms → 1500 ms) on network errors and 5xx responses.
- 429 responses retry once after the `Retry-After` header value, or 2 s if unset.
- On final failure the plugin pushes a synthetic error part (`❌ Translation failed: <reason>`) and throws from the hook, aborting the turn. No partial or Korean-mixed payload is delivered to the main LLM.

### 6.5 Parallelism

- In steady state only the newest user message is uncached per turn; everything else hits the `metadata` cache. No parallel translation pool needed.
- If multiple uncached parts are ever encountered, they are translated sequentially. This preserves contextual consistency across parts at a marginal latency cost.

### 6.6 Hash-based cache invalidation

- Cache key: `sha256(part.text).slice(0,16)`.
- When reading from `part.metadata.translated_en`, the plugin also checks `part.metadata.translated_en_hash`. A mismatch (e.g. the user edited the message) forces a re-translation.

## 7. Content Protection

The translator system prompt enforces strict preservation rules, and a lightweight post-check validates them.

### 7.1 Protected tokens

- Fenced code blocks (```` ``` ... ``` ````).
- Inline code (`` `...` ``).
- File paths (`/Users/...`, `C:\\...`, relative paths with `/` or `\\`).
- URLs (`http(s)://`, `ws(s)://`, `file://`, `mailto:`).
- `@mentions`, `#issue` references.
- Markdown structure: headings, ordered/unordered lists, tables, blockquotes.
- CamelCase / snake_case / kebab-case identifiers that do not contain spaces (heuristically kept English).

### 7.2 Prompt layout

```
System: You are a senior software-engineering translator. Translate from
{SOURCE_LANG} to {TARGET_LANG}.

Hard rules:
 1. Never translate content inside fenced code blocks (```) or inline code (`).
 2. Never translate file paths, URLs, @mentions, #refs, or English identifiers.
 3. Preserve markdown structure exactly.
 4. If the input is already in {TARGET_LANG}, return it unchanged.
 5. Output only the translation. No commentary, no preamble, no code fences
    around the whole response.

Examples:
  <<few-shot KO→EN example with protected code blocks>>
  <<few-shot EN→KO example with protected paths>>

User: <input>
```

### 7.3 Post-check

After the model responds, the plugin verifies:

- The count of fenced code blocks (` ``` `) is identical before and after.
- The set of file paths/URLs extracted via a common regex is a subset of the input set.

If either check fails, the plugin retries once with a stricter prompt ("You violated rule X on the previous attempt. Do not do it again."). A second failure surfaces as a translation error per §6.4.

## 8. Configuration

The plugin is loaded through OpenCode's standard plugin mechanism. In `opencode.json`:

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
| `model` | string | `"anthropic/claude-haiku-4-5"` | Translator model id in `provider/model-id` form. |
| `triggerKeywords` | string[] | `["$en"]` | Tokens whose presence in the first user message activates translation mode. Matched as whitespace-separated tokens; case-sensitive. |
| `targetLanguage` | string | `"en"` (= no-op) | User-facing display language, ISO-639-1 preferred (e.g. `ko`, `ja`, `zh`, `de`). If equal to the LLM language (`en`) the output step is skipped. |
| `verbose` | boolean | `false` | When `true`, logs `{direction, chars_in, chars_out, ms, cached}` per translation via `console.log` (visible under `opencode --log-level debug`). |

The LLM-facing language is hard-coded to English in v1. This mirrors the stated goal ("LLM API is only called in English") and removes a dimension of configuration that is unlikely to change.

## 9. Translation Targets Matrix

| Content | Translated? | Notes |
| --- | --- | --- |
| User text parts | Yes (source → English) | Cached via `metadata.translated_en`. |
| Last assistant text part of a completed message | Yes (English → `targetLanguage`) | Rendered as `<EN>\\n\\n---\\n\\n**<lang>:**\\n\\n<translated>`. |
| Intermediate assistant text parts between tool calls | No | English only, to keep tool-call narration terse and low-latency. |
| Reasoning parts | No | Collapsed in UI; translating adds cost without benefit. |
| Session title | Yes | Patched via `session.update`. |
| Compaction summary | Yes | Naturally caught by the last-text-part path. |
| Tool names / input / output | No | Internal plumbing; paths/commands are English. |
| Subagent (task) internal messages | No | See §3.4. |

## 10. User Experience Details

### 10.1 Input display

- The user's original message is shown exactly as typed (Korean stays Korean in the UI and in history).
- Directly below the user message, a synthetic text part shows `→ EN: <translated>`. This part has `synthetic: true`, `ignored: true`, and `metadata.role: "translation_preview"`, so it is visible but excluded from the LLM context.

### 10.2 Output display

- During streaming, the LLM's English text renders live (OpenCode's default text-delta handling).
- When the message completes, the final text part is rewritten to:

  ```
  <original English text>

  ---

  **한국어 번역:**

  <translated text>
  ```

  (The label is chosen from a small per-language table; unknown languages fall back to the ISO code in brackets.)

### 10.3 Activation banner

- On the very first turn of a translation-enabled session, a synthetic text part appears before the LLM response:
  `✓ Translation mode enabled · translator: claude-haiku-4-5 · display: ko`.

### 10.4 Failure surfaces

- Translation failure: `❌ Translation failed: <reason>. Turn aborted.` pushed as a synthetic error part; the turn is aborted before reaching the main LLM (inbound failure) or before patching (outbound failure).
- Partial-output invariants: the output-side translation is atomic per text part. If it fails, the English text stays visible (already streamed) and a trailing error banner is appended; no garbled mix is persisted.

## 11. Error Handling Summary

| Stage | Failure | Behaviour |
| --- | --- | --- |
| Inbound translation | Network / 5xx / 429 | 2 retries with backoff; on final failure abort turn with error part. |
| Inbound translation | Prompt post-check fails twice | Abort turn with error part. |
| Outbound translation | Any failure | Leave English text intact; append error banner; do not retry after streaming completes. |
| Title translation | Any failure | Swallow silently (verbose log only). Title stays English. |

## 12. Telemetry & Logging

- `verbose: false` (default) — log nothing on the happy path. Only translation failures and cache misses that required a fallback are logged.
- `verbose: true` — one line per translation call:
  `[opencode-translate] ko→en 241ch → 198ch · 412ms · cache=miss · model=claude-haiku-4-5`

No data is sent anywhere except to the configured translator provider.

## 13. Package Layout

```
opencode-translate/
├── src/
│   ├── index.ts          # default export: Plugin factory, hook wiring
│   ├── activation.ts     # keyword detection, state read/write on metadata
│   ├── translator.ts     # ai.generateText wrapper, retry, hash cache
│   ├── protect.ts        # code-block/URL/path pre & post checks
│   ├── prompts.ts        # system prompt template + few-shot fixtures
│   ├── formatting.ts     # dual-language assistant part composition / extraction
│   ├── events.ts         # event-hook logic (message-complete → patchPart)
│   └── constants.ts
├── test/
│   ├── activation.test.ts
│   ├── translator.test.ts  # hash cache + protect pre/post, translator mocked
│   ├── protect.test.ts
│   └── formatting.test.ts
├── docs/
│   ├── spec.en.md          # ← this file
│   └── spec.ko.md          # optional future mirror
├── package.json
├── tsconfig.json
├── README.md
└── .github/
    └── workflows/
        └── publish.yml     # npm publish on tag push
```

### 13.1 Dependencies

- Runtime: `@opencode-ai/plugin`, `ai`, `@ai-sdk/anthropic` (others opt-in).
- Dev: `typescript`, `bun-types`.

### 13.2 Build / publish

- `bun run build` → `tsc` emit to `dist/`.
- `bun test` for unit tests.
- GitHub Action publishes to npm on `v*` tag pushes.

### 13.3 Installation (user flow)

```bash
npm install -g opencode-translate      # or project-local
# edit ~/.config/opencode/opencode.json
# add: "plugin": [["opencode-translate", { "targetLanguage": "ko" }]]
opencode                                # start using; first message begin with $en
```

## 14. Testing Strategy

All automated tests are pure-logic with the translator mocked. Integration with a real provider is documented as a manual smoke test in the README; running it requires an `ANTHROPIC_API_KEY`.

### 14.1 Unit tests

- **`activation.test.ts`**
  - Keyword detection at start, middle, end of part text.
  - Keyword stripping preserves whitespace cleanly.
  - Multiple keywords (`["$en", "$tr"]`) detected as disjunction.
  - First-message-only: keyword in second message does not activate.
  - State round-trip: write `translate_enabled` to metadata, read back from fresh `chat.message` input.

- **`translator.test.ts`**
  - Hash cache hit skips `generateText` call.
  - Hash change (simulated edit) triggers re-translation.
  - Retry sequence: simulate 1 transient failure then success.
  - Final failure after retries surfaces as thrown error with diagnostic message.

- **`protect.test.ts`**
  - Fenced code block count preserved.
  - File paths unchanged in simulated translator output.
  - Post-check rejects outputs that lose a code block and triggers the prompt-rewrite retry.

- **`formatting.test.ts`**
  - Compose `<EN>\\n\\n---\\n\\n**<lang>:**\\n\\n<KO>` from a pair.
  - Extract the English half cleanly for the LLM-history transform hook, including when the Korean half itself contains code blocks.
  - Round-trip stability: compose → extract → compose yields the same result.

### 14.2 Manual smoke test

README documents steps to:

1. Install the plugin into a local OpenCode config.
2. Start a session with `$en 프로젝트 루트의 package.json을 읽고 요약해줘`.
3. Confirm:
   - Synthetic activation banner appears.
   - Synthetic `→ EN: ...` preview appears under the user message.
   - LLM response streams in English.
   - After completion, a `한국어 번역:` block appears below the English.
   - Subsequent messages without `$en` continue to translate in both directions.

## 15. Implementation Milestones

1. Repo scaffolding: `package.json`, `tsconfig.json`, `.gitignore`, empty plugin entry.
2. `translator.ts` + `prompts.ts` — core `ai.generateText` wrapper with retries and few-shot prompt.
3. `protect.ts` — preservation pre/post checks.
4. `activation.ts` — metadata read/write + keyword handling.
5. `chat.message` hook wiring (§5.1 steps 1–4 and pushing synthetic parts).
6. `experimental.chat.messages.transform` hook wiring (cache lookup, translate-if-missing, assistant EN extraction).
7. `event` hook wiring for message-completion → outbound translation + `session.updatePart`.
8. Title translation via `session.update`.
9. `formatting.ts` compose/extract helpers + tests.
10. End-to-end manual smoke test.
11. README with install/config/examples.
12. GitHub Action for npm publish on tags.

## 16. Open Questions / Possible v2 Extensions

- **TUI companion plugin** to surface "translation mode active" in the status bar instead of as a synthetic message part.
- **`$raw` single-message escape** to send one message untranslated without disabling the session.
- **User glossary** (`{ en: "session", target: "세션" }`) to pin domain vocabulary.
- **Tool-output annotation** where the English output is preserved but a short user-language summary is attached.
- **Auto-detected source language** with a fallback path when the user occasionally types English inside a Korean session.

None of these block v1.

## 17. References

Exact OpenCode source locations this spec depends on (verified against the current `dev` branch at spec time):

- Plugin types: `packages/plugin/src/index.ts` (Hooks interface, `Plugin` factory signature).
- `chat.message` dispatch: `packages/opencode/src/session/prompt.ts:1234`.
- `experimental.chat.messages.transform` dispatch: `packages/opencode/src/session/prompt.ts:1471`.
- `experimental.text.complete` dispatch: `packages/opencode/src/session/processor.ts:436`.
- `event` firehose: `packages/opencode/src/plugin/index.ts:244`.
- Hook dispatcher (sequential execution semantics): `packages/opencode/src/plugin/index.ts:259`.
- Plugin input / SDK client surface: `packages/plugin/src/index.ts:57`.
- Plugin auto-discovery globs: `packages/opencode/src/config/plugin.ts:33`.

Any change to these sites (renames, signature updates) must be reflected in the plugin code before release.
