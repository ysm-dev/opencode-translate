# opencode-translate

## Install

```bash
bun add -g opencode-translate
```

## Setup

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    ["opencode-translate", {
      "model": "anthropic/claude-haiku-4-5", // model to use for translation
      "lang": "Korean"                        // language you speak
    }]
  ]
}
```

## Usage

Prefix any message with `$en` to activate translation for that session.

```
$en 프로젝트 루트의 package.json을 읽고 요약해줘
```

All subsequent messages in the same session are translated automatically — no need to repeat `$en`.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | required | Translator model in `provider/model-id` form |
| `lang` | string | required | Language you speak (e.g. `"Korean"`, `"Japanese"`) |
| `triggerKeywords` | string[] | `["$en"]` | Keywords that activate translation |
| `apiKey` | string | — | API key for the translator model (falls back to opencode auth) |
| `verbose` | boolean | `false` | Print translation logs |
