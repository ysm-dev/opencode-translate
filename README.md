# opencode-translate

> Use opencode in your native language. LLM always hears English.

![banner](https://github.com/user-attachments/assets/0bb6739c-abc5-4c3e-837e-2aaf5533a359)

## Demo

![demo](./assets/demo.gif)

## Why

LLMs are worse in non-English. Benchmarks confirm it on every frontier model.

- **Claude Opus 4.7 / GPT-5.5 / Gemini 3.1 Pro**: identical coding tasks scored **5/5 in English** but dropped to **0–1/5 in Arabic and Korean** ([LILT, 2025](https://lilt.com/blog/multilingual-ai-coding-gap-non-english-developers)).
- **Anthropic's own numbers**: Japanese 96.9%, Korean 96.6%, Yoruba 80.3% — English is always the baseline ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/multilingual-support)).
- **Token tax**: Korean ~1.25×, Japanese ~1.25×, Arabic ~3× more tokens per equivalent content. Higher cost, smaller effective context.

This plugin lets you write in your language while the model works in English — best of both worlds.

> Full research write-up: [docs/why.en.md](./docs/why.en.md)

## Install

Version 2 of this plugin uses OpenCode's **v2 public plugin API**. The verified release is OpenCode **2.0.3**.
For OpenCode v1, use `opencode-translate@1`.
Start a fresh v2 session when upgrading: v1 activation metadata and historical bilingual trailers are not migrated.

```bash
bun add -g opencode-translate
```

## Setup

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-translate",
      "options": {
        "model": "openai/gpt-5.4-mini", // model to use for translation
        "variant": "minimal",          // optional model variant / thinking effort
        "lang": "Korean"               // language you speak
      }
    }
  ]
}
```

Quit and restart OpenCode after changing the plugin configuration. For a local build, run `bun install && bun run build`
and set `package` to the absolute **directory** `/path/to/opencode-translate/dist`.

## Usage

Prefix any message with `$en` to activate translation for that session.

```
$en 프로젝트 루트의 package.json을 읽고 요약해줘
```

All subsequent messages in the same session are translated automatically — no need to repeat `$en`.

- Your original message and its English translation remain visible in the transcript.
- English assistant text streams normally; a translated Markdown section is appended when the text segment completes.
- Both the **terminal and web UI** display the same persisted bilingual assistant text. No UI-specific plugin is needed.
- Question forms are translated, with selected labels and custom answers converted back to English for the model.
- Translation activates only in root sessions. Its state survives plugin/server restarts.

Before model requests, the plugin removes its recorded display translations from context. It does not remove arbitrary
Markdown based on its appearance. On inbound translation failure, the original prompt is sent unchanged; on outbound
failure, the English response is retained with a translation-unavailable notice.

## Authentication

Connect the translation model's provider in **OpenCode itself**. Translation uses the public `ctx.generate.text()` API,
so OpenCode owns provider selection, model variants, API keys, SQLite credentials, and OAuth refresh/persistence.
The plugin does not read `auth.json`/`auth-v2.json`, query the credential database, or maintain separate tokens.
Provider and OAuth support for the translation model is the support available in your OpenCode installation.

## Inline reply support

V2 has no `experimental.text.complete` hook or public display-only message append operation. Inline translations use
`session.hook("http.response", ...)` with adapters for these **main-chat response protocols**:

| Protocol | Recognized endpoint | Support |
| --- | --- | --- |
| OpenAI Responses, including Codex | `…/responses` | SSE text deltas and final snapshots |
| OpenAI Chat Completions and compatible providers | `…/chat/completions` | SSE text choices |
| Anthropic Messages | `…/messages` | SSE text blocks |
| Gemini / Vertex Gemini | `…:streamGenerateContent` | SSE non-thinking text |

Unknown endpoints, non-SSE responses, and binary protocols such as Bedrock Converse pass through unchanged with a server
log message. They still support inbound/question translation when the translation model is available through OpenCode.
Reasoning, tool calls, images, and other non-text outputs are not translated.

**Transport:** OpenCode routes sessions through HTTP when HTTP hooks are registered. Loading this plugin therefore
disables the session WebSocket fast path in its location, including sessions that have not activated `$en`.
Translations add latency at text-completion boundaries and use additional model requests. Their usage is separate from
the primary model's reported token counts.

## Development and verification

```sh
bun install
bun run check:ci
bun run typecheck
bun run knip
bun test
bun run build
bun run test:package

# Requires Node 24 and an OpenCode v2 binary; uses an isolated server and fake provider.
OPENCODE_BINARY=/path/to/opencode bun run test:host
```

Tests include OpenCode's actual native protocol parsers. The real-host smoke test loads the built plugin, creates and
rotates a test credential in an isolated SQLite database, checks bilingual persisted messages and English-only model
requests, and restarts the server to verify recovery. It does not use your live server, credentials, or paid models.

The old `opencode2 v0.0.0-dev-18322` binary does not pass this migration's host smoke test. Use the verified 2.0.3 release
rather than assuming that any binary named `opencode2` exposes the current plugin API.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | required | Translator model in `provider/model-id` form |
| `variant` | string | optional | Translator model variant / thinking effort (for example, `"minimal"`, `"high"`, or `"max"`) |
| `lang` | string | required | Language you speak (e.g. `"Korean"`, `"Japanese"`) |
| `trigger` | string[] | `["$en"]` | Keywords that activate translation |
| `verbose` | boolean | `false` | Print translation logs |
