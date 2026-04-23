# opencode-translate

`opencode-translate` is an OpenCode plugin that lets the user chat in a configured `sourceLanguage` while the main chat loop and compaction summariser only see English.

## What It Does

- Activates once per root session when the first user message contains a trigger keyword such as `$en`.
- Translates user-authored text parts from `sourceLanguage` to English before the main LLM sees them.
- Stores the original user text, plus a cached English translation in part metadata.
- Shows a visible `→ EN: ...` preview under each translated user text part.
- Translates assistant text parts from English into `displayLanguage` when each text part completes.
- Stores assistant text as:

```md
<english>

<!-- oc-translate:{nonce}:start -->
---

**{displayLanguageLabel}:**

<translated>
<!-- oc-translate:{nonce}:end -->
```

- Strips that trailer back out before later LLM turns, so the model history stays English-only.

## v1 Limits

- No mid-session toggle off.
- No auto-detection of source or display language.
- No title translation or title-path English enforcement.
- No subagent translation.
- No translation of tool inputs, tool outputs, or reasoning parts.
- Edited historical translated user messages are passed through as-is instead of being re-translated (the original edited text is what the LLM sees).

## Hook Failure Handling

Hooks never throw. If the translator fails (network error, auth failure, provider 4xx/5xx), the plugin:

1. Logs the error via `client.app.log` (visible with `verbose: true`).
2. Emits a `⚠️ Translation failed: …` synthetic part.
3. Falls back to sending the original (untranslated) user text to the model.
4. On first-turn activation failure, it also rolls back activation so the next turn retries cleanly.

A stalled provider request is additionally bounded by a 60s hard timeout per translation call, so a hung upstream cannot block the OpenCode session.

## Install

```bash
npm install -g opencode-translate
```

Add it to `~/.config/opencode/opencode.json`:

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

Then make sure the translator provider has credentials. Any of these work:

```bash
opencode auth login anthropic
export ANTHROPIC_API_KEY=...
```

Start a brand-new session and put the trigger in the first message:

```text
$en 프로젝트 루트의 package.json을 읽고 요약해줘
```

## Options

| Option | Type | Default |
| --- | --- | --- |
| `translatorModel` | string | `anthropic/claude-haiku-4-5` |
| `triggerKeywords` | string[] | `[$en]` |
| `sourceLanguage` | string | `en` |
| `displayLanguage` | string | `en` |
| `apiKey` | string | `undefined` |
| `verbose` | boolean | `false` |

## Privacy

Using this plugin means text goes to two model providers per turn:

- the normal OpenCode chat provider
- the configured `translatorModel` provider

If you need strict single-provider or self-hosted-only behavior, do not enable this plugin.

## Anthropic OAuth Support

If `translatorModel` uses Anthropic and OpenCode auth is backed by Anthropic OAuth (Claude Pro/Max), the plugin reuses those OAuth credentials for translation requests.

Anthropic's `/v1/messages` endpoint rejects OAuth-authenticated requests that do not match the Claude Code CLI fingerprint (response: `429 rate_limit_error` with an empty `"Error"` message). To pass, the plugin applies the same transformation that `@ex-machina/opencode-anthropic-auth` uses for OpenCode's main chat, but only for its own translator requests:

- `user-agent: claude-cli/2.1.87 (external, cli)`
- Required `anthropic-beta` headers (`oauth-2025-04-20`, `interleaved-thinking-2025-05-14`)
- `?beta=true` appended to the `/v1/messages` URL
- `x-anthropic-billing-header` block prepended to `system[]` (deterministic CCH of the first user message)
- `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` injected as the next `system[]` block

The technique and constants are documented in https://github.com/ex-machina-co/opencode-anthropic-auth. See `src/anthropic-oauth.ts`.

Tradeoffs:

- Relies on an undocumented Anthropic OAuth request shape. Anthropic can change this at any time and force the plugin to stop using OAuth.
- OpenCode upstream removed Anthropic OAuth support for legal / policy reasons. Installing this plugin reintroduces an equivalent code path in your environment.
- Translator requests contribute to your Claude Pro/Max rate limit alongside OpenCode's main chat.

If you prefer a plain API key, set `ANTHROPIC_API_KEY` in the environment or pass `apiKey` in plugin options. The plugin prefers explicit `apiKey`, then `ANTHROPIC_API_KEY`, then OAuth.

## Manual Smoke Test

1. Install the plugin and configure `sourceLanguage: "ko"`, `displayLanguage: "ko"`.
2. Start a new session and send `$en 프로젝트 루트의 package.json을 읽고 요약해줘`.
3. Confirm the activation banner appears.
4. Confirm the `→ EN: ...` preview appears under the user message.
5. Confirm assistant text streams in English, then gains a translated trailer when the text part finishes.
6. Confirm later messages in the same session translate without repeating `$en`.
7. Confirm editing a historical translated user message falls back to the edited text being sent as-is (with a log entry visible under `verbose: true`).
8. Confirm task-tool child sessions are not translated.
9. Confirm the title remains in the source language in v1.

## Development

```bash
bun install
bun run check      # biome format + lint + organize imports (write)
bun run typecheck  # tsgo (@typescript/native-preview, TS v7 beta)
bun test
```

To only verify without writing:

```bash
bun run check:ci
```

### Release

`main` 브랜치에 푸시될 때 `package.json`의 `version`이 npm에 아직 없는 값이면, `.github/workflows/publish.yml`이 자동으로:

1. `biome check`, `tsgo`, `bun test` 실행
2. `npm publish --provenance --access public`
3. `vX.Y.Z` git 태그와 GitHub Release 생성

버전을 올리려면 `package.json`의 `version`만 수정해 main에 merge 하세요. 이미 publish된 버전이면 workflow는 publish를 건너뜁니다.

`docs/spec.en.md` is the source of truth for behavior.
