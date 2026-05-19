# opencode-translate

## Install

```bash
npm install -g opencode-translate
```

## Setup

`~/.config/opencode/opencode.jsonc` 에 추가:

```jsonc
{
  "plugin": [
    ["opencode-translate", {
      "model": "anthropic/claude-haiku-4-5", // 번역에 사용할 모델
      "lang": "Korean"                        // 사용할 언어
    }]
  ]
}
```

## Usage

메시지 앞에 `$en` 을 붙이면 해당 세션부터 번역이 활성화됩니다.

```
$en 프로젝트 루트의 package.json을 읽고 요약해줘
```

이후 메시지부터는 `$en` 없이도 자동으로 번역됩니다.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `model` | string | required | 번역 모델 (`provider/model-id` 형식) |
| `lang` | string | required | 사용할 언어 (예: `"Korean"`, `"Japanese"`) |
| `triggerKeywords` | string[] | `["$en"]` | 번역 활성화 키워드 |
| `apiKey` | string | — | 번역 모델 API 키 (생략 시 opencode 인증 사용) |
| `verbose` | boolean | `false` | 번역 로그 출력 여부 |
