# `opencode-translate` — 명세

> 상태: Draft v5 · 담당자: [@ysm-dev](https://github.com/ysm-dev)
> 대상 플랫폼: [OpenCode](https://github.com/anomalyco/opencode) 플러그인
> 플러그인 API: `@opencode-ai/plugin` ( https://opencode.ai/docs/plugins/ )

---

## 1. 목표

OpenCode 사용자가 설정된 **`sourceLanguage`로 대화**할 수 있게 하면서도, **메인
채팅 루프**(및 그 compaction 요약기)는 **영어만** 보도록 한다. 이 플러그인은
다음을 수행하는 번역 프록시다:

1. 사용자 메시지가 메인 채팅 LLM에 도달하기 전에 `sourceLanguage`에서 영어로
   번역한다.
2. 메인 채팅 LLM이 완전히 영어만 보도록 유지한다: 모델은 메인 루프
   (`packages/opencode/src/session/prompt.ts:1471`)나 compaction 요약기
   (`packages/opencode/src/session/compaction.ts:303`)에서 소비하는 메시지
   이력에서 사용자의 원본 비영어 텍스트를 절대 보지 않는다. 두 경로 모두
   `experimental.chat.messages.transform`을 호출하며, 이 훅에서 플러그인은
   `MessageV2.toModelMessagesEffect`가 직렬화하기 전에 저장된 원본 언어
   텍스트를 캐시된 영어로 교체한다.
3. 메인 LLM의 영어 응답을 사용자가 설정한 `displayLanguage`로 다시 번역하여
   TUI/클라이언트에서 렌더링한다.
4. **세션 범위**로 동작한다: 활성화는 첫 사용자 메시지의 접두사 키워드
   (기본값 `$en`)를 통해 세션당 한 번 일어나며, 이후 그 세션의 모든
   메시지가 양방향으로 번역된다.

사용자는 예를 들어 한국어(또는 설정된 다른 원본 언어)로 입력하고, 메인 채팅
LLM은 영어를 보며, 사용자는 응답을
`<english>\n\n<start-marker>\n---\n\n**<lang>:**\n\n<translated>\n<end-marker>`
형태로 읽는다. 여기서 마커는 세션별로 고유하다(§5.2 참고).

`experimental.chat.messages.transform`을 거치지 **않는** 경로 — 그중에서도 특히
`packages/opencode/src/session/prompt.ts:157-217`의 **제목 생성** 경로(188번
줄에서 원본 저장된 사용자 파트에 직접 `MessageV2.toModelMessagesEffect(context, mdl)`를
호출) — 는 v1에서 명시적으로 범위 외다(§5.3, §16 참고).

## 2. 비목표 (v1)

- 세션 중간 토글(`$raw`, `$en off`, `/translate off`) 없음. 활성화는 세션이
  끝날 때까지 유지된다.
- 사용자의 원본 언어 또는 표시 언어 자동 감지 없음. 둘 다 `opencode.json`에서
  한 번 설정한다.
- TUI 플러그인 동반자 / 상태 바 위젯 없음. 모든 피드백은 플러그인이 소유한
  합성(synthetic) 메시지 파트와 네이티브 세션 오류 스트림을 통해 전달된다.
- 도구 이름, 도구 인자, 도구 출력의 번역 없음.
- 추론("thinking") 파트의 번역 없음.
- 서브에이전트(task 도구) 세션 내부에서의 번역 없음.
- **제목 생성 경로에서 영어 전용 강제 없음.** `prompt.ts:186-200`의 코어 제목
  생성기는 `experimental.chat.messages.transform`을 발화하지 않으므로, 제목
  LLM은 사용자의 원본(원본 언어) 첫 메시지를 받는다. 따라서 저장된 제목은
  v1에서 일반적으로 원본 언어로 남는다. 이는 알려진 제약이며 §5.3, §16 참고.
- 저장된 `compaction` 요약 파트를 `displayLanguage`로 재렌더링하지 않는다.
  §5.1 덕분에 compaction LLM은 영어를 보지만, 결과 요약 파트는 영어로
  저장되며 v1에서는 그대로 둔다.
- **편집된 과거** 사용자 메시지의 오래된 파트별 번역 캐시에 대한 자가 치유
  없음. 번역 시점에 감지된 편집은 해당 턴을 중단시킨다(§6.5 참고).
- 다중 변수(multi-variable) provider 자격 증명 합성 없음. 자격 증명에 둘 이상의
  환경 변수가 필요한 provider(예: `@ai-sdk/amazon-bedrock`은 `AWS_REGION` +
  `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`가 필요; `@ai-sdk/google-vertex`는
  project + location + key가 필요; Cloudflare는 account + gateway + token이
  필요)는 플러그인에 의해 합성되지 않는다; 번역기는 각 `@ai-sdk/*` 패키지 자체의
  환경 변수 탐색에 위임한다(§6.3.3).
- 용어집 / 사용자 사전 지원 없음 (v2).

## 3. OpenCode 플러그인 통합 제약

디자인을 기술하기 전에 플러그인 표면(surface)의 구체적인 한계를 짚어두는
것이 중요하다. 디자인이 할 수 있는 것과 할 수 없는 것을 결정하기 때문이다.
모든 줄 번호는 `anomalyco/opencode` `dev`를 추적하는 로컬 체크아웃
`/Users/chris/git/opencode` 기준이다.

### 3.1 사용하는 훅 표면

| 훅 | 시그니처 요약 | 코어에서 발화되는 위치 |
| --- | --- | --- |
| `chat.message` | `(input, output: { message, parts }) => Promise<void>` | `packages/opencode/src/session/prompt.ts:1234` |
| `experimental.chat.messages.transform` | `(input, output: { messages }) => Promise<void>` | 메인 채팅 루프: `packages/opencode/src/session/prompt.ts:1471`. Compaction 요약기: `packages/opencode/src/session/compaction.ts:303`. 제목 경로(`prompt.ts:157-217`)에서는 **발화되지 않음**. |
| `experimental.text.complete` | `(input, output: { text }) => Promise<void>` | `packages/opencode/src/session/processor.ts:436` |
| `event` | `(input: { event }) => Promise<void>` | `packages/opencode/src/plugin/index.ts:244` (모든 `Bus` 이벤트의 firehose, 플러그인별 순차 전달) |

`event`는 관찰용일 뿐이며 v1에서는 사용하지 않는다.

### 3.2 플러그인이 변경할 수 있는 것과 변경사항이 영속화되는 시점

| 훅 | 변경 대상 | 영속화되는가? |
| --- | --- | --- |
| `chat.message` | `output.message`, `output.parts[]` (새 파트 push 포함) | **예 — 단, 훅이 정상적으로 반환되었을 때만.** 코어는 훅 반환 *후* 모든 파트에 대해 `sessions.updateMessage(info)`와 `sessions.updatePart(part)`를 호출한다(`prompt.ts:1270-1271`). **훅이 throw하면 `output.parts`에 push한 내용은 저장되지 않는다** — 예외가 `createUserMessage` 밖으로 전파되며 해당 턴을 중단시킨다. 이것이 인바운드 번역의 v1 실패 모델을 합성 "번역 실패" 파트가 아닌 **호출자의 일반 오류 전송 경로를 통해 표면화되는 throw된 오류**로 정한 이유다(§6.4). |
| `experimental.chat.messages.transform` | `output.messages[i].parts[j]` 필드 (in-place) | **아니오.** 변경된 배열은 `MessageV2.toModelMessagesEffect`로 모델 메시지를 빌드하는 진행 중인 턴에만 사용된다(`prompt.ts:1477`, `compaction.ts:304`). 저장소에는 아무것도 기록되지 않는다. |
| `experimental.text.complete` | `output.text` (텍스트 파트당 문자열 하나) | **예.** 코어가 반환된 텍스트를 다시 할당하고(`processor.ts:444`) 이어서 `session.updatePart(ctx.currentText)`를 호출한다(`processor.ts:450`). 훅은 영속화된 플러그인 메타데이터를 기록할 수 없다. 오직 `text` 필드만 왕복한다. |

### 3.3 SDK 클라이언트가 할 수 있는 것과 없는 것

플러그인은 `PluginInput`을 통해 완전히 빌드된 `@opencode-ai/sdk` 클라이언트를
받는다. 관련되고 검증된 엔드포인트:

- `client.session.get({ sessionID, directory?, workspace? })`,
  `client.session.messages({ sessionID, directory?, workspace? })`,
  `client.session.message({ sessionID, messageID, directory?, workspace? })`
  — 읽기 접근. `Session.parentID`는 반환되는 스키마의 일부이며
  (`packages/sdk/js/src/v2/gen/types.gen.ts:933-940`), 플러그인이 서브에이전트
  (`task` 도구) 세션을 식별하는 방법이다(§4.5).
- `client.session.update({ sessionID, title?, permission?, time? })` —
  **`title`, `permission`, `time.archived`만 세션에서 변경 가능**
  (`packages/sdk/js/src/v2/gen/types.gen.ts:3405-3421`); 임의의 세션
  필드를 패치할 방법은 없다.
- `client.session.prompt`, `client.session.promptAsync` — 새 사용자
  메시지를 생성하고 전송한다.
- `client.provider.list()` — `GET /provider`, `ProviderListResponse`를
  반환하며 `all: Provider[]`을 가진다. 각 `Provider`는 `id`,
  `source ∈ {"env","config","custom","api"}`, `env: string[]`,
  `key?: string`, `options: Record<string,unknown>`, `models: {...}`을
  담는다(`packages/sdk/js/src/gen/types.gen.ts:1514-1526`). 번역기가
  §6.3.1에 따라 자격 증명을 해결하기 위해 사용한다. `source`가 `"env"`
  또는 `"api"`일 때 `key`는 이미 환경 변수 또는 저장된 인증에서 해결된
  상태다; `source`가 `"custom"`이거나 provider가 여러 환경 변수를 필요로
  할 때 `key`는 부재/빈 문자열/센티넬 `OAUTH_DUMMY_KEY`이다.
- `client.auth.set({ path:{id}, body: Info })` — `PUT /auth/{id}`
  (`packages/sdk/js/src/gen/sdk.gen.ts:916-925`). 플러그인이 OAuth 토큰을
  리프레시한 후(§6.3.2) 갱신된 토큰을 `auth.json`으로 다시 영속화하는 데
  사용된다. 본문 스키마는 opencode `Auth.Info` 차별화 유니온을 반영한다:
  `{type:"api", key, metadata?}`, `{type:"oauth", access, refresh,
  expires, accountId?, enterpriseUrl?}`, 또는 `{type:"wellknown", key, token}`.
- `client.app.log` — 구조화된 플러그인 로그 출력.

훅 외부에서 저장된 `Part`를 업데이트하는 SDK 엔드포인트는 **없다**. 어시스턴트
파트 텍스트 변경은 파트가 확정되는 동안 `experimental.text.complete` 훅 안에서
반드시 이루어져야 한다. 이것은 디자인에 대한 *하드* 제약이며, v1에서 마지막
하나만이 아니라 모든 어시스턴트 텍스트 파트를 번역하는 이유다(§5.2, §17 참고).

또한 auth 레코드를 읽는 SDK 엔드포인트는 **없다**(`client.auth.list()` 없음,
`client.auth.get()` 없음). `client.provider.list()`가 가장 가까운 대체이며;
OAuth 레코드(opencode가 provider별 플러그인 fetch 래퍼 뒤에 감춤)에 대해서는
플러그인이 `OPENCODE_AUTH_CONTENT` 환경 변수 오버라이드를 존중하면서
`auth.json`을 직접 읽는다(§6.3.2).

이 명세는 예제에서 원본 HTTP 라우트 형태가 아니라 **JavaScript SDK 호출 형태**를
사용한다. 내부적으로 경로/쿼리/본문을 구분하는 경우에도 SDK는 해당 인자들을
단일 파라미터 객체로 평탄화한다.

### 3.4 우리와 관련된 파트 스키마 필드

`packages/opencode/src/session/message-v2.ts`에서:

- `TextPart.text: string`
- `TextPart.synthetic?: boolean` — 사용자가 작성하지 않은 파트임을 표시한다.
- `TextPart.ignored?: boolean` — 사용자 메시지를 LLM용으로 직렬화할 때
  (`toModelMessagesEffect`, `message-v2.ts:773`) 이 파트를 건너뛰라고
  코어에 지시한다. 어시스턴트 쪽 파트 직렬화는 두 플래그 중 어느 것도
  확인하지 않는다(`message-v2.ts:828-834`).
- `TextPart.metadata?: Record<string, any>` — 파트에 연결된 자유 형식의
  영속 키/값. 캐시된 번역과 활성화 상태를 담는다.

`ignored`는 사용자 쪽에서만 존중되므로, 플러그인은 어시스턴트 파트에
`ignored`를 설정해서 LLM으로부터 콘텐츠를 숨길 수 없다. 아웃바운드 이력
재작성 전략(§5.2 참고)은 어시스턴트 쪽에서 이 문제를 해결하기 위해 정확히
존재한다.

### 3.5 플러그인 모듈 형태

이 플러그인의 v1은 생태계의 나머지와 일치시키고 V1 모듈 관련 함정을 피하기
위해 **레거시 named-export 형태**를 사용한다:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const OpencodeTranslate: Plugin = async (ctx, options) => ({
  /* hooks */
})
export default OpencodeTranslate
```

### 3.6 플러그인 옵션

`PluginOptions`는 `Record<string, unknown>`이며 팩토리의 두 번째 인자로
전달된다. 사용자는 `opencode.json`을 통해 전달한다:

```json
{
  "plugin": [["opencode-translate", {
    "sourceLanguage": "ko",
    "displayLanguage": "ko"
  }]]
}
```

따라서 `options`는 팩토리 부트스트랩 시 정확히 한 번 읽힌다.

### 3.7 `experimental.chat.messages.transform`을 우회하는 경로

이 경로들은 저장된 파트로부터 직접 `MessageV2.toModelMessagesEffect`를 통해
모델 메시지를 빌드하며, 플러그인이 먼저 이력을 재작성하도록 허용하지 않는다:

- **제목 생성**(`prompt.ts:188`) — 원본 언어의 첫 사용자 메시지를 받는다.
  플러그인은 v1에서 이 LLM 호출을 영어로 강제할 수 없다.
- **`experimental.text.complete`** 자체는 파트 단위이므로 transform 경로에
  재진입하지 않는다.

transform을 *거치는* 것 — 메인 루프와 compaction 요약기 — 은 플러그인이
텍스트를 in-place로 교체한 후 영어를 본다. 이 비대칭성은 v1이 보장할 수
있는 것과 없는 것에 관해 가장 중요한 단일 사실이다.

## 4. 트리거 & 라이프사이클

### 4.1 활성화

- 세션의 **첫 사용자 메시지**에서(그리고 **루트** 세션에서만 — `session.parentID`가
  없어야 함; §4.5 참고), 플러그인은 `chat.message` 훅 내부에서 모든 텍스트
  파트를 검사한다.
- 설정된 `triggerKeywords` 토큰(기본값 `["$en"]`)이 공백으로 구분된 토큰으로
  텍스트 파트에 포함되어 있으면 세션은 활성화된 것으로 표시된다.
- 일치한 키워드는 메시지가 저장되기 전에 in-place로 **제거**되어 LLM은
  원시 키워드를 보지 않는다.
- 플러그인이 소유한 활성화 배너 파트가 push되며 *정본 상태 앵커로 사용된다*.
  이는 `synthetic: true, ignored: true`에 아래 메타데이터를 가진 `TextPart`다:

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

  배너는 UI에 보이고 `ignored: true`가 사용자 쪽에서 존중되므로 LLM
  컨텍스트에서는 제외된다.
- `translate_nonce`는 활성화 시 `crypto.randomBytes(16).toString("hex")`로
  정확히 한 번 생성된다. 구현은 반드시 소문자 hex를 방출해야 하며,
  `/^[0-9a-f]{32}$/`와 일치하지 않는 복원된 nonce는 반드시 거부해야 한다.

### 4.2 세션 범위

한 번 활성화되면 세션은 영구적으로 번역 모드에 있다. 비활성화 명령은 없다.
영어로 직접 쓰려면 접두사 없이 새 세션을 시작한다.

### 4.3 상태 영속성

정본 상태는 활성화 배너 파트(§4.1)에 있다. 복원력을 위해 동일한 메타데이터가
플러그인이 번역하는 모든 사용자 작성 텍스트 파트에도 **중복** 기록된다.
따라서 (예: 우리가 제어하지 않는 UI 워크플로에서 삭제되어) 배너 파트를
잃어도 세션의 나머지에서 번역이 조용히 비활성화되지 않는다.

번역된 각 사용자 `TextPart.metadata`에 기록되는 영속 키:

- `translate_enabled: true`
- `translate_source_lang: "<sourceLanguage>"`
- `translate_display_lang: "<displayLanguage>"`
- `translate_llm_lang: "en"`
- `translate_nonce: "<세션 nonce>"`
- `translate_source_hash: "<lowercase hex sha256(UTF-8(part.text)).slice(0,16)>"`
- `translate_en: "<영어 번역>"`

`TextPart.metadata`는 영속 파트 저장소이므로, 플래그는 서버 재시작, 세션
재개, compaction을 거쳐도 살아남는다. 각 훅 호출 시작 시 플러그인은 이
플래그들을 활성화 배너(1순위)에서 또는 번역이 활성화된 임의의 사용자 텍스트
파트(대체)에서 읽는다. 프로세스별 `Map<sessionID, flags>`는 순전히 hot-path
캐시로만 유지되며 메타데이터에서 지연 리필된다.

### 4.4 "첫 사용자 메시지" 및 활성 세션 감지

각 훅 호출 내부에서 플러그인은 다음의 정확한 알고리즘으로 번역 상태를
해결한다:

1. `client.session.get({ sessionID, directory: ctx.directory })`로 세션을
   읽는다.
2. `session.parentID != null`이면 세션은 **비활성**이며 플러그인은 훅에서
   즉시 반환한다(§4.5).
3. `client.session.messages({ sessionID, directory: ctx.directory })`로
   저장된 메시지를 읽는다.
4. 저장된 파트에서 **유효한 번역 상태 레코드**를 찾는다. 다음이 모두
   성립할 때만 유효하다:
   - `metadata.translate_enabled === true`
   - `metadata.translate_llm_lang === "en"`
   - `metadata.translate_source_lang`가 비어 있지 않은 문자열
   - `metadata.translate_display_lang`가 비어 있지 않은 문자열
   - `metadata.translate_nonce`가 `/^[0-9a-f]{32}$/`와 일치
5. 유효한 활성화 배너 레코드
   (`metadata.translate_role === "activation_banner"`)가 존재하면 그
   레코드가 우선한다.
6. 그렇지 않고 임의의 유효한 사용자 텍스트 파트 레코드가 존재하면 세션은
   활성이며 그 레코드를 상속한다.
7. 그렇지 않고 `storedMessages.length === 0`일 때만(그리고 오직 그 경우에만)
   세션은 **새로운 루트 세션**이며 현재의 저장되지 않은 메시지가 유일한
   활성화 후보다. 플러그인은 이 메시지에서 트리거 키워드를 스캔할 수 있다.
8. 그렇지 않으면 세션은 비활성이다. 그 세션의 이후 메시지는 번역 모드를
   활성화할 수 없다.

이것이 v1의 전체 활성화 모델이다. "재개됨", "이어짐", "가져옴" 세션에 대한
별도 개념은 없다: 유효한 번역 메타데이터가 저장된 이력에 존재하면 세션은
활성이고, 그렇지 않으면 빈 루트 세션만 활성화할 수 있다.

### 4.5 서브에이전트 (task 도구)

`task` 도구가 서브에이전트를 스폰할 때 새 세션은 호출 세션으로 설정된
`parentID`와 함께 생성된다(`packages/opencode/src/tool/task.ts:67-71`에서
`sessions.create`에 `parentID: ctx.sessionID`를 전달). 플러그인은 `parentID`가
non-null인 세션을 **번역 비활성**으로 취급하며, 그런 세션에 대해서는 모든
훅에서 no-op으로 반환한다. task 프롬프트는 이미 부모 LLM이 영어로 작성하며,
사용자는 서브에이전트 내부를 직접 읽지 않는다. 부모가 서브에이전트 결과를
종합한 것은 부모 세션의 텍스트 파트를 통해 흐르며 일반 `experimental.text.complete`
경로를 통해 번역된다.

### 4.6 포크된 세션

`session.fork`는 이전 메시지와 파트 메타데이터를 완전히 새로운 루트 세션으로
복제한다(`packages/opencode/src/session/session.ts:534-566`). v1에서 이는
다음을 의미한다:

1. 원본 세션이 번역 활성화되어 있었다면, 유효한 번역 메타데이터가 저장된
   이력에 복사되므로 포크된 세션도 즉시 번역 활성화된다.
2. 포크 후 새 트리거 키워드가 필요하지 않다.
3. 원본 세션이 번역 활성화되어 있지 않았다면 포크된 세션도 번역 활성화되지
   않는다; 더 이상 비어 있지 않으므로 나중에 활성화될 수도 없다.

이 상속은 UX 일관성을 위해 의도적이다. 원시 영어 이어쓰기를 원하는 사용자는
번역 활성화된 세션을 포크하지 말고 완전히 새 세션을 시작해야 한다.

## 5. 데이터 흐름

### 5.1 인바운드 (사용자 → LLM)

```
  사용자 입력 (한국어, 첫 메시지에 "$en" 포함)
                │
                ▼
  chat.message 훅:
    0. session = client.session.get({ sessionID, directory }) → 만약
       session.parentID가 있으면 즉시 반환(서브에이전트).
    1. prior = client.session.messages({ sessionID, directory }).
    2. §4.4대로 활성 상태를 정확히 해결한다.
    3. 저장된 메시지가 없는 새 루트 세션이면 현재의 저장되지 않은 메시지에서
       트리거 키워드를 스캔하고, 발견되면 세션을 활성화한다.
    4. 이번 턴에 활성화가 발생했으면 새 32-char 소문자 hex 세션 nonce와 함께
       활성화 배너 파트(§4.1)를 생성한다.
    5. 세션이 번역 활성화된 경우:
          a. 각 사용자 작성 TextPart에 대해(합성 / ignored 파트는 건너뜀;
             §6.6):
              - 활성화 키워드를 제거한 후 `trim()` 결과가 빈 파트면
                텍스트를 그대로 두고 번역하지 *않으며* 이 파트에 대한
                미리보기도 방출하지 *않는다*
              - ai.generateText로 원본→영어 번역
              - 파트에 영속 메타데이터 기록:
                  translate_enabled, translate_source_lang,
                  translate_display_lang, translate_llm_lang,
                  translate_nonce, translate_source_hash,
                  translate_en.
         b. 번역된 원본 텍스트 파트 바로 뒤에, 번역된 원본 텍스트 파트당 하나씩
            플러그인 소유의 미리보기 파트를 push:
             { type:"text", synthetic:true, ignored:true,
               text:"→ EN: <translated>",
               metadata: { translate_role: "translation_preview",
                           translate_nonce, translate_source_hash,
                           translate_part_index } }
         c. 이번 턴에 활성화가 발생했으면 메시지의 **마지막 파트**로 활성화
            배너 정확히 하나를 추가한다.
    6. (5a)의 어떤 번역이든 §6.4의 재시도 정책 이후에도 실패하면 훅은
       THROW한다. 코어는 이번 턴에서 아직 아무것도 영속화하지 않았으므로
       (훅 반환 후 영속화; §3.2) 부분 상태가 저장소로 새지 않는다. 오류는
       호출자의 일반 오류 경로를 통해 표면화된다(§6.4, §10.4). throw 후에는
       합성 "번역 실패" 파트도 영속화되지 않으므로 그런 파트는 push하지 않는다.
    7. 이후 코어가 메시지 + 모든 (변경된 + 새) 파트를 영속화한다.
                │
                ▼
  experimental.chat.messages.transform 훅
  (메인 루프 반복당, 그리고 compaction.ts:303에서도):

    순수 캐시 조회 — 여기서 네트워크 호출 없음.

    metadata.translate_enabled가 true이고,
    metadata.translate_nonce가 활성 세션 nonce와 일치하며,
    metadata.translate_source_hash가
        lowercase-hex sha256(UTF-8(part.text)).slice(0,16)과 일치하는
    각 사용자 TextPart에 대해:
      - 이번 인메모리 패스에서만 part.text를 metadata.translate_en으로
        스왑한다(변경은 영속화되지 않음).

    번역이 활성이고, 파트가 사용자 작성이며, part.text가 비어 있지 않아서
    번역이 되었어야 하지만 캐시가 누락되었거나 해시가 불일치하는 각
    사용자 TextPart에 대해:
      - 즉석 번역을 수행하지 *않는다* — §6.5 참고. §6.4의 정확한
        `STALE_CACHE` 오류를 throw한다. 메인 LLM이 호출되기 전에 턴이
        중단된다. v1은 편집된 과거 메시지를 자가 치유하지 않는다.

    저장된 텍스트가 활성 세션 nonce와 일치하는 아웃바운드 nonce
    트레일러(§5.2 참고)를 포함하는 각 어시스턴트 TextPart에 대해, LLM에는
    원본 영어 절반만 전송되도록 시작 마커부터 끝까지를 모두 잘라낸다.
    합성 사용자 쪽 파트(우리의 것)는 사용자 쪽에서 ignored:true를 통해 이미
    제외되며, 우리는 어시스턴트 역할 파트를 절대 push하지 않는다.
                │
                ▼
  메인 채팅 LLM (및 compaction LLM)은 영어 전용 대화를 받는다.
```

**정확한 트리거 매칭 및 파트 순서 규칙**

- 플러그인은 현재 메시지의 사용자 작성 텍스트 파트를 저장 순서대로 순회한다.
- 트리거 매칭은 `storedMessages.length === 0`일 때만, 그리고 그런 사용자
  작성 텍스트 파트 전역에서만 실행된다.
- 각 파트에 대해 순서대로, 그리고 각 키워드에 대해 `triggerKeywords` 순서대로,
  플러그인은 `KEYWORD`가 리터럴로 이스케이프된 정확한 ECMAScript 패턴
  `(^|[ \t\r\n\f\v])KEYWORD(?=$|[ \t\r\n\f\v])`의 첫 일치를 찾는다.
- 파트 순서, 문자 오프셋, 키워드 배열 순서순으로 첫 일치가 우선한다. 정확히
  **하나**의 일치만 소비되며, 이후 발생은 리터럴 사용자 콘텐츠로 그대로 둔다.
- 제거는 일치한 구간의 로컬 줄에서만 아래의 정확한 치환을 순서대로 사용한다:
  - 줄 시작 형태: `KEYWORD ` → ``
  - 줄 끝 형태: ` KEYWORD` → ``
  - 둘러싸인 형태: ` KEYWORD ` → ` `
  - 단독 형태: `KEYWORD` → ``
- 다른 공백 정규화는 수행되지 않는다. 트리거 제거로 개행이 추가/제거/축약되는
  일은 없다.
- 플러그인은 기존 모든 사용자 파트의 원래 순서를 반드시 보존해야 한다.
  설명 대상인 원본 텍스트 파트 바로 뒤에 합성 미리보기 파트를 삽입할
  수 있으며, 활성화 턴에만 메시지의 맨 마지막에 활성화 배너 하나를 삽입할
  수 있다.
- `translate_part_index`는 원본 메시지의 적격한 텍스트 파트 중에서 번역된
  사용자 작성 텍스트 파트의 0-based 순번이다.

### 5.2 아웃바운드 (LLM → 사용자)

모든 텍스트 파트는 `experimental.text.complete` 내부에서 확정되며, 플러그인이
저장된 `text`를 변경할 수 있는 유일한 장소다(§3.3). 플러그인은 모델이 평범한
`<!-- ... -->` 주석이나 `---` 규칙을 출력에 우연히 방출하는 경우에도 이후
transform이 분리선을 안정적으로 찾을 수 있도록, **세션 고유** HTML-주석
마커로 구분된 영어+표시 언어 복합체로 텍스트를 재작성한다:

```
<original English>

<!-- oc-translate:{nonce}:start -->
---

**{displayLanguageLabel}:**

<translated>
<!-- oc-translate:{nonce}:end -->
```

`{nonce}`는 활성화(§4.1) 시 주조된 32자 소문자 hex 값이며, 플러그인이 방출하는
모든 텍스트 파트에 복사된다. transform 단계(§5.1)는 LLM에 이력을 넘기기 전에
**구조적으로 유효한 트레일러**만 제거한다. 파서는 엄격하다:

1. 시작 마커 줄은 정확히 `<!-- oc-translate:{nonce}:start -->`여야 한다.
2. 선택적 실패 상태 줄은 정확히 `<!-- oc-translate:{nonce}:status:failed -->`
   여야 하며, 존재하는 경우 시작 마커 바로 다음에 와야 한다.
3. 끝 마커 줄은 정확히 `<!-- oc-translate:{nonce}:end -->`여야 한다.
4. 파서는 텍스트 끝에서부터 활성 nonce와 함께 마지막 정확한 끝 마커를
   검색한다.
5. 이어서 같은 nonce의 가장 가까운 앞선 정확한 시작 마커를 역방향으로
   검색한다.
6. 후보는 끝 마커가 파트의 마지막 비어 있지 않은 줄이고 시작과 끝 사이의
   줄들이 이 섹션에 제시된 두 레이아웃 중 하나와 일치할 때만 유효하다
   (성공 트레일러 또는 실패 트레일러).
7. 후보가 유효하면 영어 절반은 시작 마커 바로 앞의 빈 줄 이전 텍스트의
   정확한 접두사다.
8. 후보가 유효하지 않으면 파트는 일반 영어로 취급되며 **아무것도 잘리지
   않는다**.

이 훅에서 번역 실패 시 플러그인은 `output.text`를 그대로 두고 같은 nonce로
실패 트레일러를 덧붙인다:

```
<original English>

<!-- oc-translate:{nonce}:start -->
<!-- oc-translate:{nonce}:status:failed -->
---

_Translation unavailable for this segment._

<!-- oc-translate:{nonce}:end -->
```

이는 다음 턴에서도 transform 경로를 대칭적으로 유지하며(전체 트레일러가
LLM이 이력을 보기 전에 제거됨), 다음 턴을 기다리지 않고 실패를 사용자에게
즉시 인라인으로 보여준다.

모든 어시스턴트 텍스트 파트는 번역된다 — 최종 파트만이 아니다. 이는 제품
인터뷰에서 포착된 "최종 답변만 번역" 선호(§18)로부터의 의식적 이탈이며,
§3.3에 의한 것이다.

### 5.3 세션 제목, compaction, 기타 코어 내부 LLM 호출

**Compaction 요약기.** `experimental.chat.messages.transform`을 거친다
(`compaction.ts:303`). 따라서 compaction LLM은 영어를 본다. *저장된* compaction
요약 파트는 compaction LLM이 생성한 텍스트(영어)이며 v1에서는 사용자의
`displayLanguage`로 재렌더링되지 않는다. compaction 요약은 `message-v2.ts:795-800`을
통해 "지금까지 무엇을 했나?"로 프롬프트 내부에 표면화되므로, 영어로 두면
이후 LLM 턴을 일관되게 유지한다.

**세션 제목.** 제목 경로(`packages/opencode/src/session/prompt.ts:157-217`)는
188번 줄에서 저장된 파트에 직접 `MessageV2.toModelMessagesEffect(context, mdl)`를
호출한다 — `experimental.chat.messages.transform`을 호출하지 **않는다**. 따라서
플러그인은 v1에서 이 LLM 호출을 영어로 강제할 수 없다. 저장된 제목은 일반적으로
원본 언어가 된다. 플러그인에서 이를 바꿀 수 있는 유일한 방법은:

- 새 업스트림 훅(예: `experimental.session.title`)을 도입하거나,
- `session.updated`를 청취하여 루프 회피 마커와 함께
  `client.session.update({ sessionID, title })`를 발행하여 사후에 제목을
  번역하는 것이다.

둘 다 v2 후보다. §16 참고.

## 6. 번역 엔진

### 6.1 라이브러리 선택

- **`ai` npm 패키지 + provider SDK**(예: `@ai-sdk/anthropic`)를 `generateText`를
  통해 사용.
- 스크래치 세션에서 `client.session.prompt`를 거치지 않음: 그렇게 하면 실제
  opencode 세션이 스폰되어 모든 플러그인 훅이 재귀 실행되고 UI에 세션이
  누출된다.
- 원시 HTTP를 거치지 않음: provider별 분기를 강제한다.

### 6.2 기본 모델

- `anthropic/claude-haiku-4-5` — 저렴하고 빠르며 코드 인접 텍스트에 강하다.
- 플러그인 옵션 `translatorModel`로 설정 가능.

### 6.3 인증

번역기는 v1부터 opencode의 저장된 인증과 자격 증명을 공유한다. 플러그인은
아래의 우선순위 순서를 사용하여 매 번역기 호출 전에 `apiKey`(그리고 OAuth
기반 provider의 경우 커스텀 `fetch`)를 해결한다. 새 구성 옵션은 도입되지
않는다; `opencode auth login <provider>`를 실행한 사용자는 자동으로 해당
자격 증명을 번역기에서 사용할 수 있게 된다.

#### 6.3.1 자격 증명 해결 순서

`translatorModel`에서 파싱된 provider `P`(예: `"anthropic/claude-haiku-4-5"`
에서 `"anthropic"`)에 대해, 해결기(resolver)는 첫 일치를 사용하여
`{ apiKey?: string, fetch?: typeof fetch }`을 생성한다:

1. **플러그인 옵션.** `opencode.json`에 `options.apiKey`가 설정되어 있으면
   이를 `apiKey`로 사용한다. `fetch` 오버라이드 없음.
2. **SDK를 통한 opencode 저장 인증.** `client.provider.list()`를 호출하여
   `p = result.all.find(x => x.id === P)`를 찾는다:
   - `p.source === "api"`이고 `p.key`가 `OAUTH_DUMMY_KEY`
     (`"opencode-oauth-dummy-key"`, `packages/opencode/src/auth/index.ts:7`)가
     아닌 비어 있지 않은 문자열이면 `p.key`를 `apiKey`로 사용한다. 이는
     `auth login → Manually enter API Key` 경로다.
   - 그렇지 않고 `p.source === "env"`이며 `p.key`가 비어 있지 않은 문자열이면
     `p.key`를 `apiKey`로 사용한다. opencode가 이미 환경 변수를 해결해 두었으므로,
     해결된 값을 재사용하면 플러그인 팩토리와 이후 훅 호출 사이의 process-env
     드리프트를 피할 수 있다.
   - 그렇지 않고 `p.source === "custom"`**이거나** `p.key === OAUTH_DUMMY_KEY`
     이면 §6.3.2의 OAuth 재사용 경로를 활성화한다. `apiKey: ""`와 커스텀
     `fetch` 래퍼를 모두 설정한다.
   - 그렇지 않고 `p.key`가 `undefined`이고 `p.env.length > 1`이면 provider는
     다중 변수다: §6.3.3을 따른다.
3. **`@ai-sdk/*` 패키지 기본값.** 위의 어느 것도 해결되지 않으면 팩토리에
   `apiKey`를 전달하지 않고 `@ai-sdk/*` 패키지가 자체의 정본 환경 변수를 읽도록
   한다(예: `@ai-sdk/anthropic`은 `ANTHROPIC_API_KEY`를 읽음;
   `@ai-sdk/google`은 `GOOGLE_GENERATIVE_AI_API_KEY`를 읽음;
   `@ai-sdk/openai`는 `OPENAI_API_KEY`를 읽음). 이는 이전 v4 동작을 대체
   수단으로 보존한다.
4. **오류.** 3단계조차 자격 증명 누락으로 호출 시점에 throw하는 팩토리를
   산출하면 해결기는 이를 `AUTH_UNAVAILABLE` 오류(§6.4)로 번역한다.

해결기는 **매 번역기 호출당 한 번** 실행되지만 프로세스 수명 동안 동일한
provider에 대한 결과를 메모이제이션한다. 단, OAuth 래퍼는 예외로 `fetch`
자체가 요청별로 액세스 토큰을 재해결한다(§6.3.2). 해결 오류는 절대 캐싱되지
않는다; 매 호출마다 재시도한다.

#### 6.3.2 OAuth 재사용

세 가지 OAuth 기반 provider가 지원된다. `translatorModel`을 통해 이들 중
하나가 선택되고 해결이 §6.3.1 2단계의 "OAuth 재사용 활성화" 분기에 도달하면,
플러그인은 provider별로 최소 실행 가능한 인증 요청 형태를 재구성한다.

**인증 파일 탐색.** 플러그인은 원시 `auth.json` 맵을 다음 순서로 읽는다:

1. `process.env.OPENCODE_AUTH_CONTENT`가 설정되어 있으면 JSON 객체
   (`Record<providerID, Info>`)로 파싱한다.
   `packages/opencode/src/auth/index.ts:59-63`과 일치한다.
2. `$XDG_DATA_HOME/opencode/auth.json` — `xdg-basedir` 의미로 해결한다.
   플랫폼별 폴백:
   - macOS: `~/Library/Application Support/opencode/auth.json`
   - Linux: `~/.local/share/opencode/auth.json`
   - Windows: `%LOCALAPPDATA%\opencode\auth.json`
3. 둘 다 존재하지 않거나 0o600 모드의 JSON으로 파싱에 실패하면 OAuth
   재사용은 `undefined`를 반환하고 해결기는 §6.3.1의 3단계로 폴백한다.

**provider별 요청 형태.**

| `providerID` | 리프레시 엔드포인트 | 요청 본문 | Bearer 출처 | 매 요청마다 필요한 추가 사항 |
| --- | --- | --- | --- | --- |
| `anthropic` | `POST https://console.anthropic.com/v1/oauth/token` | `{"grant_type":"refresh_token","refresh_token":<refresh>,"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}` (Content-Type: `application/json`) | `info.access` | `Authorization: Bearer <access>`; `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14`; `anthropic-version: 2023-06-01`; `x-api-key` 삭제; `/v1/messages`에 선택적 `?beta=true` 쿼리. |
| `openai` (Codex) | `POST https://auth.openai.com/oauth/token` | `{"grant_type":"refresh_token","refresh_token":<refresh>,"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","scope":"openid profile email offline_access"}` (form 본문) | `info.access` | `Authorization: Bearer <access>`; `ChatGPT-Account-Id: <info.accountId>`; URL을 `api.openai.com/v1/chat/completions` 및 `api.openai.com/v1/responses`에서 `https://chatgpt.com/backend-api/codex/responses`로 재작성. |
| `github-copilot` | 토큰 교환 `GET https://api.github.com/copilot_internal/v2/token`을 `Authorization: token <info.refresh>`로 | 해당 없음 (bearer GitHub PAT가 `refresh`에 있음) | 교환이 반환한 세션 토큰(응답당 만료) | `Authorization: Bearer <session_token>`; `Editor-Version: opencode-translate/<version>`; `Editor-Plugin-Version: opencode-translate/<version>`; `Copilot-Integration-Id: vscode-chat`. `info.enterpriseUrl`이 설정되어 있으면 `api.githubcopilot.com` 대신 이를 base URL로 사용. |

**리프레시 의미.**

- 각 OAuth 레코드는 `expires < Date.now() + 60_000`(60초 안전 여유)으로
  검사된다. opencode 자체의 OAuth 플러그인은 여유가 0이다
  (`plugin/codex.ts:417`); 시계 왜곡과 진행 중인 요청 지연을 흡수하기 위해
  여유를 추가한다.
- 리프레시는 프로세스 내 `Map<providerID, Promise<Info>>`를 통해
  **providerID별로 직렬화**된다. 동시 번역기 호출은 단일 리프레시 프라미스로
  병합되어, 회전된 리프레시 토큰이 서로를 무효화하지 않도록 한다 — 이는
  opencode 자체 플러그인에 실재하는 경쟁 조건이며 이 플러그인이 재현해서는
  안 된다.
- 리프레시 성공 후 새 `{access, refresh, expires}`는
  `client.auth.set({ path: { id: providerID }, body: { type: "oauth", access,
  refresh, expires, accountId?, enterpriseUrl? } })`를 통해 영속화되어
  opencode와 플러그인이 동기화된 상태를 유지한다. 플러그인은 절대
  `auth.json`을 직접 쓰지 않는다.
- `auth.json` 읽기는 항상 디스크(또는 설정되어 있으면
  `OPENCODE_AUTH_CONTENT`)에서 다시 수화된다; 진행 중인 리프레시 프라미스만
  프로세스 내에 캐싱된다.

**요청 어댑터.** OAuth provider에 대해 플러그인은 `{ apiKey: "", fetch: customFetch }`
로 `@ai-sdk/<pkg>` 팩토리를 구성하며, 여기서 `customFetch(input, init)`는:

1. `resolveOAuth(providerID)`를 호출하여 필요 시 리프레시하고 현재 `Info`를
   반환한다.
2. `Authorization: Bearer <info.access>`(또는 Copilot의 경우 토큰 교환 결과)와
   위에 나열된 provider별 추가 헤더를 설정한다.
3. 필요한 곳에서 `x-api-key`를 삭제한다(Anthropic).
4. 필요한 곳에서 URL을 재작성한다(Codex).
5. 전역 `fetch`에 위임하고 그 `Response`를 반환한다.

플러그인은 opencode가 커밋 `1ac1a0287`("anthropic legal requests")에서 제거한
악용 탐지 회피를 **재현하지 않는다**: 도구 이름 `mcp_` 접두사 재작성, User-Agent
스푸핑(`claude-cli/2.1.2 (external, cli)`), 시스템 프롬프트 텍스트 치환
(`OpenCode` → `Claude Code`). 요청은 플러그인 자체의 User-Agent
(`opencode-translate/<version>`)로 나간다. Anthropic이 그러한 요청을 거부하면
(401/403/차단된 응답), 오류는 일반 §6.4 실패 표면
(`INBOUND_TRANSLATION_FAILED` 또는 아웃바운드 실패 트레일러)을 통해 표면화된다;
사용자는 `translatorModel`을 API 키 provider로 변경하거나 `options.apiKey`를
구성할 수 있다.

#### 6.3.3 다중 변수 provider

해결된 `Provider`가 `p.key === undefined`이고 `p.env.length > 1`이면,
플러그인은 자격 증명을 읽거나 구성하려 **시도하지 않는다**. 팩토리에 `apiKey`를
전달하지 않고 하위 `@ai-sdk/*` 패키지가 자체의 정본 환경 변수를 읽도록 한다
(예: `@ai-sdk/amazon-bedrock`은 `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`을 읽음;
`@ai-sdk/google-vertex`는 `GOOGLE_VERTEX_PROJECT`,
`GOOGLE_VERTEX_LOCATION`, `GOOGLE_VERTEX_API_KEY`를 읽음).

플러그인은 다중 변수 provider에 대해 절대 `client.auth.set`을 호출하지 않는다.
`cloudflare`와 같은 provider에 대해 `auth.json`에 저장된 자격 증명
(`{type:"api", key, metadata: { accountId, gatewayId }}`)은 번역기가 무시한다;
해당 provider 사용자는 동등한 환경 변수를 설정하거나 단일 변수
`translatorModel`로 전환해야 한다. 이는 §2에 v1 비목표로 나열되어 있다.

#### 6.3.4 센티넬 감지

문자열 `"opencode-oauth-dummy-key"`는 `packages/opencode/src/auth/index.ts:7`
에서 `OAUTH_DUMMY_KEY`로 정의되어 있으며, provider가 플러그인 로더를 통해
OAuth 기반일 때 opencode가 `provider.key`로 반환하는 값이다. `p.key`를 읽는
어떤 해결기 분기든 이 정확한 값을 "키 없음"으로 취급하고, `p.source`가
`"custom"`이 아니더라도 폴백**해야 한다**. 빈 문자열도 동일하게 취급된다.

#### 6.3.5 법적 / ToS 주의

Anthropic OAuth 재사용은 문서화되지 않은 토큰 엔드포인트
(`console.anthropic.com/v1/oauth/token`), 문서화되지 않은 베타 헤더
(`anthropic-beta: oauth-2025-04-20`), 그리고 하드코딩된 `client_id`
(`9d1c250a-e61b-44d9-88ed-5944d1962f5e`, Anthropic이 자체 `claude_cli`용으로
등록함)에 의존한다. 업스트림 opencode는 커밋 `1ac1a0287`("anthropic legal
requests")에서 이 흐름을 **제거**했다; 역사적 `opencode-anthropic-auth@0.0.13`
npm 패키지는 deprecated 상태다("Package no longer supported").

Anthropic OAuth 자격 증명으로 `opencode-translate`를 활성화한다는 것은 번역기가
그 토큰을 재사용하려 시도한다는 뜻이다. Anthropic은 그러한 트래픽을 지문 인식하여
rate-limit을 걸거나 차단할 수 있다. 플러그인은 opencode가 제거한 회피를 재구현하지
않는다; 자체 User-Agent로 요청을 발행하며 도구 이름 재작성이나 시스템 프롬프트
치환을 하지 않는다. 이 위험을 수용하지 않으려는 사용자는 (a) `ANTHROPIC_API_KEY`
또는 `opencode auth login anthropic → Manually enter API Key`를 통해 평문 API
키를 구성하거나, (b) `translatorModel`을 non-Anthropic provider로 설정해야 한다.
README는 이 경고를 두드러지게 반복한다.

### 6.4 재시도 정책

플러그인은 정확하고 안정적인 메시지 템플릿을 가진 평범한 `Error` 인스턴스를
throw하므로, 호출자가 이를 일관되게 표시하거나 매칭할 수 있다.

| 조건 | 정확히 throw되는 메시지 |
| --- | --- |
| 새 메시지의 인바운드 번역이 재시도 후 실패 | `[opencode-translate:INBOUND_TRANSLATION_FAILED] Failed to translate user message from {sourceLanguage} to en: {reason}` |
| transform에서 과거 번역된 메시지 해시 불일치 / 캐시 누락 | `[opencode-translate:STALE_CACHE] A previously translated user message was edited. Resend the message or start a new session.` |
| 해결기가 번역기 provider에 대해 사용 가능한 자격 증명을 찾지 못함 | `[opencode-translate:AUTH_UNAVAILABLE] No credential found for provider "{providerID}". Set {envVar} in the environment, run "opencode auth login {providerID}", or set options.apiKey in opencode.json.` |
| OAuth 리프레시가 재시도 후 실패 | `[opencode-translate:OAUTH_REFRESH_FAILED] Failed to refresh OAuth token for provider "{providerID}": {reason}. Re-authenticate with "opencode auth login {providerID}".` |

`{reason}`은 번역기/provider 오류를 다음과 같이 정규화한 것이다: 첫 줄만,
`trim()` 적용, 최대 200자. `{envVar}`는 provider의 `env: string[]` 배열의
첫 번째 항목이다(예: `anthropic`의 경우 `ANTHROPIC_API_KEY`); `env`가 비어
있으면 리터럴 문자열 `the provider's API key env var`로 치환된다.

- 네트워크 오류 및 5xx 응답에 대해 지수 백오프(500ms → 1500ms)로 2회 재시도.
  번역기 호출과 OAuth 리프레시 호출 모두에 적용된다.
- 429는 `Retry-After` 이후 또는 헤더가 없으면 2초 후 1회 재시도.
- `AUTH_UNAVAILABLE`은 해결 불가능한 번역기 provider를 처음 사용하려 할 때
  (일반적으로 첫 `chat.message` 훅 발화 시) 생성된다; 플러그인은 `@ai-sdk/*`
  패키지가 이미 하는 것 이상으로 `process.env`를 스캔하여 자격 증명을 추측하려
  시도하지 않는다. 위의 정확한 오류 텍스트는 안정적이며 문자열 매칭에 안전하다.
- `OAUTH_REFRESH_FAILED`는 플러그인이 실제로 리프레시를 시도했고 엔드포인트가
  재시도 후에도 non-2xx를 반환했을 때 또는 응답 본문이 예상 토큰 JSON으로
  파싱될 수 없을 때만 생성된다. 리프레시가 불필요할 때(토큰이 여전히 유효할
  때)는 생성되지 않는다.
- 최종 실패 시:
  - **인바운드**(`chat.message`에서): 구조화된 오류와 함께 **훅에서
    throw**. `chat.message`의 변경은 정상 반환 후에만 영속화되므로(§3.2)
    부분 상태가 저장되지 않는다. 플러그인은 위의 정확한 throw 메시지를
    보장한다. 호출자는 이를 다르게 표면화한다:
    - `client.session.prompt(...)`와 동기 `/session/{id}/prompt` 라우트는
      그 메시지와 함께 요청을 실패시킨다.
    - `client.session.promptAsync(...)`와 `/prompt_async`는 서버 라우트가
      실패를 잡아 재발행하기 때문에 현재 나중에 `Session.Event.Error`를
      방출한다(`session.ts:917-929`).
    플러그인은 동기 호출자에 대해 합성 인채팅 파트나 세션 버스 이벤트를
    보장하지 **않는다**. 오직 throw된 메시지 텍스트만 보장한다.
  - **인바운드**(`experimental.chat.messages.transform`에서): 위의 정확한
    `STALE_CACHE` 메시지와 함께 throw. 이전 글머리표의 전송 주의사항이
    동일하게 적용된다.
  - **아웃바운드**(`experimental.text.complete`에서): `output.text`를
    그대로 두고 활성 세션 nonce로 인라인 실패 트레일러(§5.2)를 덧붙인다.
    사용자는 영어 응답과 번역이 실패했다는 작은 인라인 알림을 즉시
    본다; 다음 턴의 transform 단계가 트레일러를 제거하여 LLM은 영어
    전용 이력을 본다.
  - **인증 해결**(모든 훅): 위의 정확한 `AUTH_UNAVAILABLE` 또는
    `OAUTH_REFRESH_FAILED` 메시지를 감싸는 훅과 동일한 전송 규칙으로
    throw한다(`chat.message`에서의 throw는 턴을 중단; `experimental.chat.messages.transform`
    에서의 throw는 LLM 호출 전에 중단; `experimental.text.complete`에서의
    throw는 `{reason}`을 인증 오류의 첫 줄로 설정하여 아웃바운드 실패
    트레일러를 통해 표면화됨).

### 6.5 캐싱

- **키**: `lowercase hex sha256(UTF-8(part.text)).slice(0, 16)`,
  `metadata.translate_source_hash`로 저장.
- **위치**: 사용자 텍스트 파트의 `metadata.translate_en` +
  `metadata.translate_source_hash`. `chat.message`가 기록하고
  `experimental.chat.messages.transform`이 읽는다.
- **무효화**: transform은 저장된 해시를 현재 `part.text` 해시와 비교한다.
  불일치(편집된 과거 사용자 메시지)는 턴을 중단시킨다(§5.1, §6.4). v1은
  transform 훅 내부에서 캐시 미스 시 조용히 **재번역하지 않는다**. 이유:
  1. transform 변경은 영속화되지 않으므로(§3.2), 재번역된 값은 턴 후 버려지고
     다음 턴에도 같은 미스가 발생한다 — 비싼 무한 재번역 루프.
  2. 올바른 해결은 사용자가 메시지를 다시 보내는 것(`chat.message`에 재진입하여
     캐시를 다시 채움)이거나 새 세션을 시작하는 것이다.

따라서 번역 활성화된 세션에서 *과거* 메시지를 편집하는 것은 v1에서
지원되지 않는다. v2 계획은 §16 참고.

### 6.6 병렬성 & 범위 제어

- 플러그인은 사용자 작성 텍스트 파트 — `synthetic !== true`이고
  `ignored !== true`인 파트 — 만 번역한다. 이는 opencode 자체의 합성
  파트(예: `compaction.ts:442`의 compaction 자동 이어짐 마커로
  `compaction_continue: true`를 가짐)를 제외하여 내부 영어 플러밍이 번역기에
  의해 망가지지 않도록 한다.
- 정상 상태에서는 턴당 가장 새로운 사용자 메시지만 캐시되지 않은 상태이며,
  그 외는 모두 메타데이터 캐시에 적중한다. 번역 호출은 순서를 보존하고
  provider rate-limit을 예측 가능하게 유지하기 위해 순차적으로 발행된다.
- transform 훅은 네트워크 호출을 절대 하지 않으므로(§6.5), 도구 집약적인
  턴에서도 O(messages)로 저렴하게 유지된다.

## 7. 콘텐츠 보호

### 7.1 보호되는 구간

보호 엔진은 결정적이다.

- 번역 전에 원본 문자열에서 실행된다.
- 좌에서 우로 스캔한다.
- 아래 나열된 정확한 우선순위 순서로 추출기가 실행된다.
- 일치는 겹치지 않는다: 일단 텍스트가 플레이스홀더로 치환되면 이후 추출기는
  그 안을 검사하지 않는다.
- 플레이스홀더 인덱스는 `0`에서 시작하여 추출 순서로 증가하며, 정확히
  `⟦OCTX:{kind}:{index}⟧` 형태의 토큰을 생성한다.

정확한 추출기 순서:

1. 삼중 백틱 또는 삼중 틸드로 구분된 펜스 코드 블록.
2. 단일 백틱으로 구분된 인라인 코드.
3. `http://`, `https://`, `ws://`, `wss://`, `file://`, `mailto:`와 일치하는
   URL.
4. `/`로 시작하는 POSIX 절대 경로.
5. `^[A-Za-z]:\\`과 일치하는 Windows 절대 경로.
6. `/` 또는 `\\`을 포함하고 마지막 세그먼트가 다음 정확한 확장자로 끝나는
   상대 경로:
   `c`, `cc`, `cpp`, `css`, `go`, `h`, `hpp`, `html`, `ini`, `java`,
   `js`, `json`, `jsx`, `kt`, `md`, `py`, `rs`, `sh`, `sql`, `swift`,
   `toml`, `ts`, `tsx`, `xml`, `yaml`, `yml`, `zsh`.
7. `$NAME`, `${NAME}`, `%NAME%` 형태의 환경 변수 참조(`NAME`은
   `[A-Z_][A-Z0-9_]*`).
8. `at ` 또는 `    at `로 시작하고 `path:line:column` 접미사를 포함하는
   JS 스타일 줄과 일치하는 스택 트레이스 프레임.
9. Unified-diff hunks: 연속된 diff 블록의 일부일 때 `@@ `, `+++ `, `--- `,
   `+`, `-`로 시작하는 줄.
10. JSON / YAML 키: 줄 시작 또는 들여쓰기 후 바로 `:`이 뒤따르는 따옴표
    또는 무관 토큰.
11. 단일 줄의 `<...>`과 일치하는 XML / HTML 태그.
12. 리터럴 `<!-- oc-translate:`과 일치하는 프롬프트 제어 마커 및 이번 턴에
    제거된 활성화 키워드의 단일 소비된 발생.
13. `@mentions`, `#issue` 참조, `[0-9a-f]{7,40}`과 일치하는 git ref.
14. 길이 ≥ 3인 다음 정확한 형태의 단독 식별자:
    `camelCase`, `PascalCase`, `snake_case`, `kebab-case`,
    `SCREAMING_SNAKE_CASE`.

짧은 셸 플래그는 항목 1의 펜스 쉘 블록 내부에서만 보호된다. v1에는 자유
텍스트 셸 플래그 추출기가 **없다**.

번역기가 반환된 후 플러그인은 모든 플레이스홀더를 정확한 문자열 치환으로
**복원**한다. 해결되지 않은 플레이스홀더, 중복된 플레이스홀더, 환각된 새
플레이스홀더는 보호 위반으로 취급된다.

### 7.2 프롬프트 레이아웃

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

### 7.3 사후 검사

각 번역 후 플러그인은 다음을 검증한다:

- 사전 검사가 방출한 모든 `⟦OCTX:…⟧` 플레이스홀더가 번역기 출력에 정확히
  한 번 존재하며, 추가 플레이스홀더가 환각되지 않았다.
- 전후 펜스 코드 블록 개수가 동일하다(심층 방어 — 플레이스홀더 단계가 이미
  이를 보장해야 함).
- (사전 검사 목록에서의) URL 및 파일 경로 개수가 일치한다.

실패 시 플러그인은 더 엄격한 프롬프트로 한 번 재시도한다("플레이스홀더
⟦OCTX:…⟧는 반드시 그대로 나타나야 합니다. 이전 출력은 {list}를 누락했습니다.
모든 플레이스홀더가 복원된 완전한 번역을 방출하세요."). 두 번째 실패는 §6.4의
재시도/중단 정책을 통해 표면화된다.

## 8. 구성

`opencode.json`을 통해:

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

| 옵션 | 타입 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `translatorModel` | string | `"anthropic/claude-haiku-4-5"` | `ai`의 provider 해석기가 이해하는 `provider/model-id` 형태의 번역기 모델 id. |
| `triggerKeywords` | string[] | `["$en"]` | 루트 세션의 첫 사용자 메시지에 존재할 때 번역 모드를 활성화하는 토큰. 공백 구분 토큰으로 매칭; 대소문자 구분. |
| `sourceLanguage` | string | `"en"` | 사용자가 입력하는 언어. ISO-639-1 권장(`ko`, `ja`, `zh`, `de`, …). `"en"`과 같을 때 **인바운드** 번역 단계는 no-op. |
| `displayLanguage` | string | `"en"` | 플러그인이 어시스턴트 출력을 렌더링하는 언어. `"en"`과 같을 때 **아웃바운드** 번역 단계는 no-op. |
| `apiKey` | string | `undefined` | 선택 사항. 설정되면 번역기 provider의 `apiKey`로 그대로 사용되며 opencode의 저장된 인증과 환경 변수보다 우선한다(§6.3.1). 번역기가 메인 채팅과 다른 자격 증명을 사용하기를 원하는 사용자를 위한 것. |
| `verbose` | boolean | `false` | `true`일 때 `client.app.log`를 통해 번역 통계를 로깅(`opencode --log-level debug`로 표시). |

LLM 대면 언어는 v1에서 영어로 고정된다.

**자격 증명 해결.** 자격 증명은 §6.3에 따라 해결된다; 사용자는 일반적으로
표준 `opencode auth login <provider>` 흐름 또는 provider의 정본 환경 변수
설정 외에는 아무것도 할 필요가 없다. `apiKey`는 비상 탈출구로 제공되며
일반적인 경우에는 필요하지 않다.

퇴화된 구성:

- `sourceLanguage === "en"`이고 `displayLanguage === "en"` → 플러그인은
  완전한 no-op; 활성화는 여전히 작동하지만 아무것도 번역하지 않는다.
- `sourceLanguage === displayLanguage !== "en"` → 일반적인 한국어↔영어 형태.
- `sourceLanguage !== displayLanguage`(예: 사용자는 일본어로 쓰고 한국어로
  읽기를 원함)는 지원된다; 매 턴마다 양쪽 레그가 실행된다.

## 9. 번역 대상 매트릭스

| 콘텐츠 | 번역? | 참고 |
| --- | --- | --- |
| 사용자 작성 텍스트 파트(`synthetic !== true`, `ignored !== true`) | 예(원본 → 영어) | `metadata.translate_en` + `translate_source_hash`에 캐싱. |
| 합성 사용자 텍스트 파트(opencode의 compaction 자동 이어짐, 우리의 배너/미리보기 등) | 아니오 | 내부 영어 플러밍을 손상시키지 않도록 §6.6에서 건너뜀. |
| 모든 어시스턴트 텍스트 파트 | 예(영어 → `displayLanguage`) | 매 `text-end`마다. nonce 범위의 마커 쌍으로 이중 언어로 렌더링. |
| 추론 파트 | 아니오 | UI에서 접힘; 번역은 이익 없이 비용을 더한다. |
| 세션 제목 | **아니오, 그리고 v1에서 영어로도 강제되지 않음** | 경로가 transform을 우회한다(§3.7, §5.3). v2 후보. |
| Compaction LLM 입력 | 예(`compaction.ts:303`의 transform 경유) | Compaction 모델은 영어를 본다. |
| Compaction 요약 *저장소* 파트 | 아니오 | v1에서는 영어로 유지; 이후 턴에서 상속됨. |
| 도구 이름 / 입력 / 출력 | 아니오 | 내부 플러밍; 경로와 명령은 영어. |
| 서브에이전트(task) 내부 메시지 | 아니오 | 세션에 `parentID`가 있음; 플러그인이 조기 반환(§4.5). |

## 10. 사용자 경험 세부사항

### 10.1 입력 표시

- 사용자의 원본 메시지는 입력한 그대로 표시된다; 원본 언어는 UI와 저장소
  모두에서 원본 언어로 유지된다.
- 사용자 메시지 바로 아래에, 플러그인 소유 텍스트 파트가 `→ EN: <translated>`를
  `synthetic: true, ignored: true, metadata.translate_role: "translation_preview"`로
  보여준다. 이는 UI에서 보이며, 사용자 쪽 직렬화기(`message-v2.ts:773`)가
  `ignored:true` 텍스트 파트를 건너뛰므로 LLM 컨텍스트에서는 제외된다.

### 10.2 출력 표시

스트리밍 중에는 LLM의 영어 텍스트가 라이브로 렌더링된다. 각 텍스트 파트가
완료되면 저장된 `text`가 다음으로 재작성된다:

```
<original English text>

<!-- oc-translate:{nonce}:start -->
---

**{displayLanguageLabel}:**

<translated text>
<!-- oc-translate:{nonce}:end -->
```

`{displayLanguageLabel}`은 다음의 정확한 매핑 표에서 선택된다:

| `displayLanguage` | 레이블 |
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

다른 코드는 정확한 문자열 `Translation (<displayLanguage>)`로 폴백한다.

### 10.3 활성화 배너

번역 활성화된 세션의 첫 턴에, 플러그인 소유 활성화 배너가 메인 LLM 응답 앞에
나타난다:

```
✓ Translation mode enabled · translator: claude-haiku-4-5 · source: ko · display: ko
```

### 10.4 실패 표면

- **인바운드 실패(새 메시지)**: `chat.message` 훅이 §6.4의 정확한
  `INBOUND_TRANSLATION_FAILED` 문자열을 throw한다; 턴은 LLM으로 진행되지
  않으며 그 턴의 어떤 것도 영속화되지 않는다(§3.2). 동기 호출자는 실패한
  요청을 본다. 비동기 호출자는 서버가 오류를 잡아 재발행하므로 현재
  동일한 메시지를 `Session.Event.Error`를 통해 표면화한다.
- **인바운드 실패(과거 메시지의 오래된 캐시)**: transform이 §6.4의 정확한
  `STALE_CACHE` 문자열을 throw한다. 위와 동일한 호출자 의존 전송.
- **아웃바운드 실패**: 영어는 (이미 스트리밍된) 가시 상태로 남고 플러그인이
  인라인 실패 트레일러(§5.2)를 덧붙여, 사용자가 영어 바로 아래에
  `_Translation unavailable for this segment._` 알림을 본다. 트레일러는
  다음 턴의 transform에서 제거되므로 이력은 영어 전용으로 유지된다.
- **번역기 자격 증명 누락(`AUTH_UNAVAILABLE`)**: 플러그인은 첫 번역기 호출에서
  §6.4의 정확한 `AUTH_UNAVAILABLE` 문자열을 throw한다. throw는 자격 증명이
  먼저 필요했던 훅(일반적으로 인바운드 번역 중 `chat.message`)에서 발생한다;
  전송은 해당 훅의 throw 의미를 따른다. 메시지는 정본 환경 변수 이름과
  정확한 `opencode auth login` 명령을 포함하므로, 사용자는 명세를 읽지 않고도
  설정을 교정할 수 있다.
- **OAuth 리프레시 실패(`OAUTH_REFRESH_FAILED`)**: 번역기 오류와 마찬가지로
  감싸는 훅의 전송을 통해 표면화된다. 메시지는 사용자에게 새 리프레시 토큰을
  주조하기 위해 `opencode auth login <providerID>`를 다시 실행하라고 지시한다.
  플러그인은 조용히 재인증을 시도하지 않는다.

## 11. 오류 처리 요약

| 단계 | 실패 | 동작 |
| --- | --- | --- |
| 인바운드 번역(`chat.message`) | 네트워크 / 5xx / 429 | 백오프로 2회 재시도; 최종 실패는 정확한 `INBOUND_TRANSLATION_FAILED`를 throw; 턴 중단; 아무것도 영속화되지 않음. 전송은 호출자 경로에 따라 동기 요청 실패 또는 비동기 `Session.Event.Error`. |
| 인바운드 번역(`chat.message`) | 플레이스홀더 사후 검사가 두 번 실패 | 위와 동일. |
| 인바운드 transform(`experimental.chat.messages.transform`) | 과거 메시지의 캐시 미스 또는 해시 불일치 | 정확한 `STALE_CACHE`를 throw; 턴 중단. 전송은 호출자 경로에 따라 동기 요청 실패 또는 비동기 `Session.Event.Error`. |
| 아웃바운드 번역(`experimental.text.complete`) | 임의의 실패 | 영어를 가시 상태로 두고; 활성 nonce로 인라인 실패 트레일러를 덧붙임; 사용자가 이미 인라인으로 보므로 다음 턴 합성 경고는 필요 없음. |
| 자격 증명 해결(모든 훅) | 번역기 provider에 대해 사용 가능한 `apiKey` / `fetch` 없음 | 정확한 `AUTH_UNAVAILABLE`를 throw; 감싸는 훅의 throw 지점에서 턴 중단. 전송은 감싸는 훅의 규칙을 따름. |
| OAuth 리프레시(모든 훅) | 리프레시 엔드포인트가 재시도 후 non-2xx 반환, 또는 응답 파싱 불가 | 정확한 `OAUTH_REFRESH_FAILED`를 throw; 감싸는 훅의 throw 지점에서 턴 중단. 이전의 성공한 리프레시로 얻은 리프레시된 토큰은 `client.auth.set`를 통해 영속화된 상태로 유지됨. |

## 12. 원격 측정 & 로깅

- `verbose: false`(기본값) — 조용한 해피 패스; 실패만 로깅된다.
- `verbose: true` — 번역 호출당 로그 한 줄을 `client.app.log({ body: { service: "opencode-translate", level: "info", message: "translated", extra: { direction, chars_in, chars_out, ms, cached, model } } })`를
  통해.

**개인정보.** 이 플러그인을 활성화하면 세션의 사용자 및 어시스턴트 텍스트가
턴당 **두 개의 외부 LLM provider**를 거친다: opencode에 구성된 메인 채팅
provider와 여기 구성된 `translatorModel` provider. 엄격한 데이터 거주 또는
셀프 호스팅 전용 제약을 가진 사용자에게 이는 플러그인 없이 opencode를
실행하는 것과는 실질적으로 다른 변경이다. README가 이를 명시적으로 언급한다.
플러그인 자체는 구성된 `translatorModel` provider 외의 어디에도 데이터를
보내지 않는다.

## 13. 패키지 레이아웃

`opencode-md-table-formatter`와 `opencode-vibeguard`를 거의 그대로 따라가며,
추가 빌드 오케스트레이션 없이 기존 생태계에 드롭인되도록 한다.

```
opencode-translate/
├── src/
│   ├── index.ts          # default named export; 훅 연결
│   ├── activation.ts     # 키워드 감지, 메타데이터 상태
│   │                     # 읽기/쓰기, 세션 nonce 주조,
│   │                     # 서브에이전트 감지
│   ├── translator.ts     # ai.generateText 래퍼, 재시도, 해시 캐시
│   ├── auth.ts           # 자격 증명 해결(§6.3.1),
│   │                     # OPENCODE_AUTH_CONTENT를 존중하는 auth.json 리더,
│   │                     # anthropic / openai (codex) / github-copilot용
│   │                     # OAuth 리프레시 + 커스텀 fetch 팩토리
│   ├── protect.ts        # 플레이스홀더 기반 사전/사후 보호
│   ├── prompts.ts        # 시스템 프롬프트 템플릿 + few-shot 픽스처
│   ├── formatting.ts     # 이중 언어 compose/extract 헬퍼
│   │                     # (nonce 범위 마커)
│   ├── labels.ts         # 언어별 표시 레이블
│   └── constants.ts
├── test/
│   ├── activation.test.ts
│   ├── translator.test.ts    # 캐시 + 재시도 + 보호, 모의됨
│   ├── auth.test.ts          # 우선순위 순서, OAuth 리프레시, 센티넬
│   ├── protect.test.ts
│   ├── formatting.test.ts
│   └── labels.test.ts
├── docs/
│   └── spec.en.md            # ← 이 파일
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

컴파일된 `dist/`는 없다 — opencode의 플러그인 로더는 `opencode-md-table-formatter`와
같은 방식으로 Bun에서 `.ts`를 직접 실행한다.

### 13.2 엔트리 모듈

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

두 로더 경로(레거시 named-export 루프 및 V1 모듈 형태)를 수용하기 위해
named export와 default export 양쪽.

### 13.3 설치

```bash
# 한 번만 전역 설치
npm install -g opencode-translate
# 이어서 ~/.config/opencode/opencode.json에 추가:
# "plugin": [["opencode-translate", {
#   "sourceLanguage": "ko", "displayLanguage": "ko"
# }]]

# 번역기 provider에 자격 증명이 있는지 확인한다. 다음 중 하나:
#   a) opencode auth login anthropic    (권장; opencode와 공유됨)
#   b) export ANTHROPIC_API_KEY=sk-ant-...
# 둘 다 작동한다; 플러그인은 §6.3.1에 따라 해결한다.

opencode    # 새 세션의 첫 메시지를 "$en"으로 시작
```

## 14. 테스트 전략

모든 자동화된 테스트는 번역기가 모의된 순수 로직이다. 실제 provider와의
통합은 README의 수동 스모크 테스트로 문서화되며 `ANTHROPIC_API_KEY`가
필요하다.

### 14.1 단위 테스트

- **`activation.test.ts`**
  - 파트 텍스트의 시작, 중간, 끝에서의 키워드 감지.
  - 키워드 제거가 공백을 깔끔히 보존.
  - 정확한 제거 예제가 고정되어 있다:
    - `$en hello` → `hello`
    - `hello $en world` → `hello world`
    - `hello\n$en world` → `hello\nworld`
    - `hello $en\nworld` → `hello\nworld`
    - `literal $en and trigger $en`은 §5.1로 선택된 첫 일치 발생만 제거하고
      두 번째는 그대로 둔다.
  - 복수 키워드(`["$en", "$tr"]`)는 OR로 매칭.
  - 첫 메시지 전용: 두 번째 메시지의 키워드는 활성화하지 않음.
  - 자식 세션(`client.session.get`이 반환하는 세션의 non-null `parentID`)이
    감지되고 플러그인은 no-op이다.
  - 번역된 포크 세션은 복사된 메타데이터가 §4.4를 만족하므로 새 트리거 없이
    번역 모드를 상속한다.
  - 미번역 포크 세션은 영구적으로 비활성으로 남는다.
  - 메타데이터 왕복: 가짜 `{message, parts}` 출력에 `translate_enabled`,
    `translate_source_lang`, `translate_display_lang`, `translate_nonce`를
    기록하고 배너 앵커와 사용자 파트별 대체 양쪽을 통해 다시 읽는다.
  - 복수 파트 순서가 정확함: `[text,file,text]`가 활성화 턴에
    `[text,preview,file,text,preview,banner]`가 된다.
- **`translator.test.ts`**
  - 해시 캐시 적중은 `generateText`를 건너뜀.
  - transform 훅에서 해시 불일치는 정확한 `STALE_CACHE` 메시지를 throw하고
    `generateText`를 호출하지 *않는다*.
  - 합성 사용자 파트(`synthetic: true` 또는 `ignored: true`)는 건너뜀;
    특히 compaction 자동 이어짐 마커(`metadata.compaction_continue === true`)는
    번역되지 않은 채로 남는다.
  - 재시도: 1회 시뮬레이션된 일시적 실패 후 성공.
  - `chat.message`에서 재시도 후 최종 실패는 정확한
    `INBOUND_TRANSLATION_FAILED` 접두사를 가진 throw(훅 수준 중단
    시뮬레이션); 실패 코드 경로에서 파트가 방출되지 않음.
- **`protect.test.ts`**
  - 모든 플레이스홀더 종류(코드 블록, 경로, URL, 셸 플래그, env 변수,
    JSON 키, 스택 프레임, diff hunks, 정규식, HTML 태그)가 왕복.
  - 플레이스홀더를 누락시키는 시뮬레이션된 번역기가 더 엄격한 재시도
    경로를 트리거.
  - 추가 플레이스홀더를 환각하는 시뮬레이션된 번역기가 사후 검사에서
    감지됨.
- **`formatting.test.ts`**
  - nonce `N`으로 compose:
    `<EN>\n\n<!-- oc-translate:N:start -->\n---\n\n**<lang>:**\n\n<KO>\n<!-- oc-translate:N:end -->`.
  - extract: 해당 트레일러가 있는 저장된 파트에 대해, EN 절반을 복구하면
    정확히 `<EN>`이 반환됨.
  - 적대적: 영어 절반 자체에 *다른* nonce의 리터럴 문자열
    `<!-- oc-translate:OTHER:start -->`가 포함된 어시스턴트 응답은
    절단되지 *않음*.
  - 적대적: 영어 절반에 단독 `---` 수평 규칙이 포함된 어시스턴트 응답은
    절단되지 *않음*.
  - 실패 트레일러 왕복: compose-with-failure → extract가 LLM 이력용으로
    정확히 `<EN>`을 반환하고 UI 표시 텍스트가
    `_Translation unavailable for this segment._` 알림을 포함.
  - 파서 엄격성: 잘못된 트레일러, 끝 마커 이후 공백이 아닌 줄이 있는
    트레일러, 불일치하는 nonce는 일반 영어로 취급되며 절단되지 *않음*.
  - Compose → extract → compose가 안정적.
 - **`labels.test.ts`**
  - `en`, `ko`, `ja`, `zh`, `zh-CN`, `zh-TW`, `de`, `fr`, `es`에 대한
    정확한 매핑 표.
  - 알 수 없는 코드는 `Translation (<displayLanguage>)`로 폴백.
- **`auth.test.ts`**
  - 우선순위 순서: 플러그인 `options.apiKey`가 모의된 `client.provider.list()`
    의 `api`-source `provider.key`를 이긴다.
  - `api`-source `provider.key`가 `env`-source `provider.key`를 이긴다
    (실제로는 모의 리스트가 provider당 하나의 source만 방출하겠지만, 이
    테스트는 해결기가 source 레이블을 잘못 해석하지 않는지 검증한다).
  - `env`-source `provider.key`는 존재할 때 사용된다.
  - `source === "env"` 또는 `source === "api"`일 때도 `provider.key ===
    "opencode-oauth-dummy-key"`는 "키 없음"으로 취급되며 해결기는 폴백한다.
  - `provider.key === ""`는 동일하게 취급된다.
  - `provider.key === undefined`이고 `provider.env.length > 1`이면 `apiKey`
    없이 팩토리를 생성하며, 그 팩토리 자체의 환경 변수 탐색은 모의되지 않는다.
  - `OPENCODE_AUTH_CONTENT` 오버라이드: `{"anthropic":{"type":"oauth", ...}}`
    를 가진 JSON 문자열로 설정되면 OAuth 분기는 파일 시스템을 건드리지 않고
    이를 읽는다.
  - OAuth 리프레시: 신선한 토큰(`expires > Date.now() + 60_000`)은 리프레시
    엔드포인트를 건너뛴다; 만료된 토큰은 한 번의 리프레시 호출을 트리거한다;
    응답은 모의된 `client.auth.set({ path: { id: "anthropic" }, body: {...} })`
    를 통해 영속화된다.
  - OAuth 리프레시가 병합됨: 리프레시 중 두 개의 동시
    `resolveOAuth("anthropic")` 호출은 토큰 엔드포인트에 정확히 한 번의
    네트워크 호출을 생성한다.
  - OAuth 리프레시 실패는 2회 재시도 후 정확한 `OAUTH_REFRESH_FAILED`
    메시지를 throw한다; 재시도 횟수는 번역기의 재시도 정책과 일치한다.
  - OAuth 요청 헤더: 모의 `fetch` 검증이 `Authorization: Bearer <access>`,
    필수 `anthropic-beta` 헤더(`oauth-2025-04-20` 포함), `anthropic-version:
    2023-06-01`, `x-api-key` 부재, `/v1/messages`에 대한 `?beta=true` 존재를
    확인한다.
  - 플러그인은 opencode가 제거한 User-Agent `claude-cli/...`나 도구 이름
    `mcp_` 접두사를 **방출하지 않는다**; 검증이 회귀를 잡아낸다.
  - 누락된 자격 증명 경로는 모의된 `provider.env[0]`에서 올바르게 치환된
    `{providerID}`와 `{envVar}`를 가진 정확한 `AUTH_UNAVAILABLE` 메시지를
    생성한다. 빈 `env` 배열은 `the provider's API key env var` 리터럴로
    폴백한다.
  - Provider-list fetch 실패(SDK 오류)는 `AUTH_UNAVAILABLE`을 throw하지
    않는다; 대신 해결기는 3단계(ai-sdk 기본값)로 폴백하며, 그것도 실패해야만
    auth 오류를 표면화한다.

### 14.2 수동 스모크 테스트 (README에 문서화)

1. 플러그인을 전역 설치.
2. `sourceLanguage: "ko"`, `displayLanguage: "ko"`로
   `~/.config/opencode/opencode.json`에 추가.
3. 다음으로 새 세션 시작:
   `$en 프로젝트 루트의 package.json을 읽고 요약해줘`.
4. 확인:
   - 플러그인 소유 활성화 배너가 나타남.
   - 플러그인 소유 `→ EN: …` 미리보기가 사용자 메시지 아래에 나타남.
   - LLM 응답이 영어로 스트리밍됨.
   - 각 텍스트 파트가 완료되면 nonce 범위 HTML 주석으로 감싸진 마크다운
     구분선 아래에 한국어 번역이 나타남.
   - `$en` 없는 이후 메시지도 양방향으로 번역됨.
   - 이 세션에서 과거 사용자 메시지를 편집하고 재전송하면 조용한 오역이
     아니라 명확한 "오래된 번역 캐시" 오류가 발생.
   - 메시지 1에 `$en` 없음 → 세션에 대해 플러그인이 no-op.
   - `task` 도구 서브에이전트를 실행해도 자식 세션에서 아무것도 번역되지
     않음.
   - 세션 제목이 원본 언어로 나타남(알려진 v1 제약, §5.3).

## 15. 구현 마일스톤

1. 레포 스캐폴딩: `package.json`, `tsconfig.json`, `.gitignore`, 빈 플러그인
   엔트리.
2. `translator.ts` + `prompts.ts` — 재시도와 few-shot 프롬프트를 갖춘 코어
   `ai.generateText` 래퍼.
3. `protect.ts` — 플레이스홀더 기반 보호.
4. `activation.ts` — 키워드 감지, 세션 nonce 주조, 서브에이전트 감지, 배너와
   파트별 메타데이터.
5. `formatting.ts` — nonce 범위 구분선 체계용 compose/extract 헬퍼.
6. `chat.message` 훅 — 활성화 + 인바운드 번역 + 배너 + 미리보기 + 실패 시
   throw 의미.
7. `experimental.chat.messages.transform` 훅 — 캐시 전용 조회 + 어시스턴트
   파트의 EN 추출 + 해시 불일치 중단.
8. `experimental.text.complete` 훅 — 아웃바운드 번역 + 이중 언어 구성 +
   인라인 실패 트레일러.
9. 단위 테스트.
10. README + 예제(명시적 개인정보 주의 사항 포함).
11. 수동 스모크 테스트.
12. `v*` 태그 푸시 시 npm에 발행하는 GitHub Action.

## 16. 미해결 질문 / 가능한 v2 확장

- **제목 번역 / 강제화.** 업스트림 훅(예: `experimental.session.title`)을
  도입하여 제목 생성 LLM 호출이 플러그인을 거치도록 하거나,
  `session.updated`에서 루프 회피 마커와 함께 `client.session.update`를 통해
  `session.title`을 사후 재작성해야 함.
- **디스플레이용 compaction 요약 파트 번역**, 요약기가 영어를 생성한 후(v1이
  이미 보장). 간단한 v2 후속: 사후 경로 또는 새 훅을 통해 저장된 `compaction`
  파트 텍스트를 번역.
- **TUI 동반자 플러그인**으로 상태 바 번역 표시기.
- **`$raw` 단일 메시지 이스케이프**로 세션을 비활성화하지 않고 한 메시지를
  번역 없이 전송.
- **사용자 용어집**(`{ en: "session", target: "세션" }`) 도메인 어휘용.
- **자동 감지 원본 언어**, 비영어 세션 내부에서 사용자가 영어로 입력할 때
  대체.
- 코어가 메시지 완료 훅(예: `experimental.message.complete`)을 성장시키면
  **"최종 텍스트 파트만" 출력 번역**.
- **편집된 과거 사용자 메시지의 자가 치유**: 플러그인이 턴을 중단하는 대신
  파트별 캐시를 갱신할 수 있도록 영속 파트 업데이트 SDK 엔드포인트나 전용
  편집 훅이 필요함.

이 중 어느 것도 v1을 막지 않는다.

## 17. 이전 드래프트 대비 적용된 수정

명세의 Draft v2에는 opencode 소스를 두 번째로 읽었을 때에야 드러난 몇 가지
디자인 이슈가 있었다. 인라인 변경 로그를 유지하면 향후 재검토가 더 빨라진다.

- **`chat.message` throw vs 합성 파트 수정.** v2는 플러그인이 합성 "번역
  실패" 오류 파트를 push한 다음 훅에서 throw한다고 주장했다. 코어는 *정상*
  반환 후에만 `output.parts`를 영속화하므로(§3.2) 그 조합은 오류 메시지를
  삼켰을 것이다. v3는 깨끗이 throw하고 `Session.Event.Error`를 통해 표면화
  하도록 전환한다.
- **언어 모델 분리.** `targetLanguage`가 "사용자가 입력하는 것"과 "사용자가
  읽는 것"을 뒤섞었다. v3는 이를 `sourceLanguage`와 `displayLanguage`
  (그리고 고정된 `llmLanguage = "en"`)로 분리하고, `metadata.translate_user_lang`
  → `metadata.translate_source_lang`으로 이름을 바꾸고
  `metadata.translate_display_lang`을 추가한다.
- **nonce 범위 어시스턴트 구분선.** v2는 모델이 정당하게 방출할 수 있는
  고정 리터럴 `<!-- opencode-translate:divider -->`을 사용했다. v3는
  세션별 nonce에서 파생된 `<!-- oc-translate:{nonce}:start -->` / `:end`
  마커를 사용하며, transform 단계는 활성 nonce만 존중한다.
- **transform 훅은 이제 캐시 전용.** v2는
  `experimental.chat.messages.transform` 내부에서 즉석 재번역을 허용했다.
  transform 변경은 영속화되지 않으므로 매 턴 무한 재번역 루프를 위험에 빠뜨렸다.
  v3는 transform을 순수 캐시 조회로 만들고 해시 불일치 시 턴을 중단한다.
- **개인정보 문구 수정.** v2는 "구성된 번역기 provider 외에는 데이터가
  절대 전송되지 않는다"고 주장했는데, 이는 오해의 소지가 있었다 — 데이터는
  이전과 마찬가지로 메인 채팅 provider에도 간다. v3의 §12는 이중 provider
  노출에 대해 명시적이다.
- **플레이스홀더 기반 보호**가 코드 블록, 경로, URL에 대한 "번역기에게 정중히
  요청"을 대체하고, 셸 플래그, env 변수, JSON 키, 스택 프레임, diff hunks,
  정규식 리터럴, HTML/XML 태그를 추가한다.
- **서브에이전트 감지**는 이제 추상적인 "서브에이전트 컨텍스트" 개념이 아닌
  `Session.parentID`에 기반한다(`packages/sdk/js/src/v2/gen/types.gen.ts:933-940`의
  `client.session.get` 스키마에 대해 검증됨).
- **Compaction 범위 명확화.** compaction 요약기는
  `experimental.chat.messages.transform`을 호출하므로(`compaction.ts:303`),
  v1에서 compaction LLM은 영어를 본다. v2는 이를 불필요하게 연기했다.
- **제목 범위 명확화(제약으로).** 제목 경로는 transform을 호출하지 *않으므로*
  (`prompt.ts:186-200`), v1은 제목 LLM 호출을 영어로 강제할 수 없다. 이는
  이제 명시적 비목표다.
- **활성화 앵커 이동** "첫 사용자 메시지의 첫 텍스트 파트"에서 플러그인 소유
  배너 파트로, 그리고 복원력을 위해 번역된 모든 사용자 텍스트 파트에 메타데이터
  복제.
- **호출자 의존 오류 전송 명확화.** v3는 throw된 `chat.message` 실패가 항상
  가시적인 `Session.Event.Error`가 되는 것처럼 여전히 읽혔다. v4는 동기 요청
  실패를 비동기 `prompt_async` 재발행과 구분하고 정확한 throw 메시지 텍스트만
  보장한다.
- **첫 메시지와 포크 의미 고정.** v4는 활성화를 다음과 같이 정의한다: 유효한
  저장된 번역 메타데이터가 우선하며, 그렇지 않으면 빈 루트 세션만 활성화할
  수 있다. `session.fork`가 파트 메타데이터를 복제하므로 포크된 세션은 원본
  세션의 번역 상태를 의도적으로 상속한다.
- **SDK 예제 수정.** v3는 원시 HTTP 라우트 형태와 SDK 호출 형태를 혼합했다;
  v4는 JS SDK 인자 형태를 일관되게 사용한다.
- **트리거 제거, 파트 순서, 트레일러 파싱을 정확하게 만듦.** v4는 매칭 순서,
  치환 규칙, 합성 파트 삽입 순서, 어시스턴트 트레일러 파서를 수정하여 독립
  구현들이 수렴하도록 한다.
- **보호 토크나이저와 레이블 표를 결정적으로 만듦.** v4는 고정된 추출기 우선
  순위 순서, 정확한 상대 경로 확장자 목록, 정확한 `displayLanguageLabel`
  매핑 표를 추가한다.
- **opencode 인증 공유를 v1로 승격(§6.3).** v4는 인증 공유를 v1 범위 외로
  정했다(환경 변수 전용). v5는 `client.provider.list()`를 통해 opencode의
  저장된 인증에서 자격 증명을 읽고, OAuth 기반 provider(`anthropic`,
  `openai` / Codex, `github-copilot`)에 대해서는 `auth.json`에서 직접
  리프레시 + 커스텀 fetch 흐름을 재구성한다. 우선순위 순서: `options.apiKey`
  → opencode 저장 인증 → 환경 변수(ai-sdk 기본 폴백). OAuth 리프레시는
  opencode 자체 플러그인에 내재된 리프레시 토큰 경쟁을 피하기 위해
  providerID별로 병합되며, 리프레시된 토큰은 opencode와 플러그인의
  동기화를 유지하기 위해 `client.auth.set`를 통해 다시 영속화된다. 다중 변수
  provider(Bedrock, Vertex, Cloudflare)는 v1 비목표로 나열됨: 번역기는 그
  provider들에 대해 각 `@ai-sdk/*` 패키지 자체의 환경 변수 탐색에 위임한다.
- **Anthropic OAuth에 대한 법적/ToS 인정(§6.3.5).** v5는 업스트림 opencode가
  커밋 `1ac1a0287`("anthropic legal requests")에서 Anthropic OAuth를
  제거했고 `opencode-anthropic-auth@0.0.13` npm 패키지가 deprecated
  상태임을 명시적으로 언급한다. 플러그인은 존재할 때 Anthropic OAuth 토큰을
  재사용하지만, opencode가 제거한 회피(User-Agent 스푸핑, 도구 이름 `mcp_`
  접두사 재작성, 시스템 프롬프트 텍스트 치환)를 재도입하지 않는다. Anthropic
  OAuth 자격 증명으로 플러그인을 활성화하는 사용자는 Anthropic이 그런
  트래픽에 rate-limit을 걸거나 차단할 수 있다는 위험을 수용한다.
- **두 개의 새 오류 템플릿(§6.4).** `AUTH_UNAVAILABLE`과
  `OAUTH_REFRESH_FAILED`가 실행 가능한 구제(환경 변수 이름과 `opencode auth
  login` 명령)를 포함하는 정확하고 안정적인 메시지와 함께 추가된다.
- **새 `apiKey` 구성 옵션(§8).** opencode 저장 인증과 환경 변수 모두를 이기는
  선택적 플러그인 오버라이드. 번역기가 메인 채팅 provider와 다른 자격 증명을
  사용하기를 원하는 사용자를 지원한다.
- **새 `src/auth.ts` 모듈과 `auth.test.ts` 스위트(§13, §14.1).** 번역기 로직이
  전송에 무관하도록 자격 증명 해결, OAuth 리프레시 병합, 커스텀 fetch 구성을
  플러그인의 나머지로부터 분리한다.

## 18. 소스 인터뷰 요약 (미래 기여자용)

이 명세는 디자인 인터뷰와 리뷰 패스의 결과물이다. 내려진 결정을 순서대로:

1. 활성화: 첫 메시지 키워드 → 전체 세션 ON.
2. 저장: 사용자의 원본 텍스트를 유지하고 턴당 영어로 번역하며 캐싱.
3. 번역기: 전용 저렴 모델(기본 Haiku), `translatorModel`로 설정 가능.
4. 보호: 코드 블록, 인라인 코드, 파일 경로, URL, 식별자, 셸, env, JSON 키,
   스택 프레임, diff, 정규식, 태그에 대한 플레이스홀더 기반.
5. 스트리밍 UX: 영어를 라이브로 스트리밍하고, 각 텍스트 파트가 완료되면
   nonce 범위 마커 쌍 안에 표시 언어 번역을 추가.
6. 입력 표시: 사용자의 원본 아래에 플러그인 소유 파트로 영어 미리보기 표시.
7. 비활성화: v1에 없음.
8. 실패 처리: 2회 재시도; 인바운드 최종 실패는 훅에서 throw(합성 오류
   파트 없음); 아웃바운드 실패는 인라인 실패 트레일러 방출.
9. 추론: 번역하지 않음.
10. 제목: **v1에서 영어로 강제할 수 없음**; 연기.
11. Compaction: v1에서 LLM은 영어를 봄(transform을 상속); 저장된 요약은
    영어로 유지.
12. 서브에이전트: 번역하지 않음; `session.parentID`로 감지.
13. 배포: `ysm-dev`의 GitHub 조직 아래 공개 npm 패키지.
14. 활성화 상태: 플러그인 소유 배너 파트(정본) + 사용자 파트별 메타데이터
    (대체).
15. 원본 및 표시 언어: 둘 다 사용자가 설정(`sourceLanguage`,
    `displayLanguage`); LLM 언어는 영어로 고정.
16. 번역기 호출: SDK 프롬프트가 아닌 직접 `ai.generateText`.
17. 빈/코드 전용 메시지: 접두사가 존재하면 여전히 번역됨(플레이스홀더 보호가
    대부분의 일을 함).
18. "마지막 답변만 번역" 선호: 인정되지만 오늘의 훅 표면으로는 기술적으로
    불가능(§3.3); v1에서는 모든 텍스트 파트가 번역된다.
19. 활성화 알림: 플러그인 소유 배너 파트.
20. 구성 옵션: `translatorModel`, `triggerKeywords`, `sourceLanguage`,
    `displayLanguage`, `verbose`.
21. 번역기 프롬프트: 강한 지시 + 2 few-shot + 플레이스홀더 규칙.
22. 테스트: 번역기 모의된 순수 로직만.
23. 디버그: 오류는 항상; 해피 패스 원격 측정을 위한 verbose 플래그.
24. 과거 편집: v1에서 미지원; transform이 해시 불일치 시 턴을 중단.
25. opencode 인증과의 자격 증명 공유: v1에서 번역기는 opencode의 저장된 인증과
    자격 증명을 공유한다(api/env source에 대해서는 `client.provider.list()`를
    통한 `auth.json`; OAuth 레코드에 대해서는 `OPENCODE_AUTH_CONTENT`를
    존중하는 파일 직접 읽기). OAuth 재사용은 `anthropic`, `openai`(Codex),
    `github-copilot`에 대해 항상 켜져 있다. 우선순위 순서는 `options.apiKey` →
    opencode 저장 인증 → 환경 변수. 구성 토글 없음; Anthropic OAuth에 대한
    법적/ToS 위험은 §6.3.5에 문서화되어 있다.

## 19. 참고자료

- OpenCode 플러그인 문서: https://opencode.ai/docs/plugins/
- OpenCode SDK 문서: https://opencode.ai/docs/sdk/
- 플러그인 API 타입:
  `packages/plugin/src/index.ts` (Hooks, Plugin, PluginInput,
  PluginOptions, PluginModule).
- 훅 디스패치 사이트(모두 로컬 체크아웃 `/Users/chris/git/opencode`에 대해
  검증됨):
  - `chat.message`: `packages/opencode/src/session/prompt.ts:1234`
  - `experimental.chat.messages.transform` (메인 루프):
    `packages/opencode/src/session/prompt.ts:1471`
  - `experimental.chat.messages.transform` (compaction):
    `packages/opencode/src/session/compaction.ts:303`
  - `experimental.text.complete`:
    `packages/opencode/src/session/processor.ts:436`
  - 제목 경로 (transform을 호출하지 **않음**):
    `packages/opencode/src/session/prompt.ts:157-217`
  - `event` (firehose): `packages/opencode/src/plugin/index.ts:244`
- 파트 스키마: `packages/opencode/src/session/message-v2.ts:106-122`
  (TextPart), 773번 줄의 사용자 쪽 `ignored` 필터와 828번 줄부터 시작하는
  어시스턴트 쪽 직렬화기.
- 세션 스키마(`parentID` 등):
  `packages/sdk/js/src/v2/gen/types.gen.ts:933-940`.
- 세션 `update` 허용 필드:
  `packages/sdk/js/src/v2/gen/types.gen.ts:3405-3421` (오직 `title`,
  `permission`, `time.archived`).
- 서브에이전트 세션 생성(`parentID` 설정):
  `packages/opencode/src/tool/task.ts:67-71`.
- Compaction 자동 이어짐 마커(번역 시 건너뛸 내부 영어 플러밍):
  `packages/opencode/src/session/compaction.ts:442`.
- ID 헬퍼(합성 파트 ID 생성용):
  `packages/opencode/src/id/id.ts` — 접두사 `prt_`.
- 참고 플러그인:
  - https://github.com/franlol/opencode-md-table-formatter (`experimental.text.complete`만
    사용; 우리와 가장 가까운 형태).
  - https://github.com/inkdust2021/opencode-vibeguard
    (`experimental.chat.messages.transform` + `experimental.text.complete` 결합;
    우리의 인바운드/아웃바운드 분리와 직접 평행).
  - 내부: `packages/opencode/src/plugin/codex.ts`, `cloudflare.ts`,
    `github-copilot/copilot.ts` — 훅 등록, SDK를 통한 읽기,
    `chat.params`/`chat.headers` 사용의 정본 예제.
- 인증 / 자격 증명 해결(모두 §6.3에서 참조됨):
  - `packages/opencode/src/auth/index.ts:7` — `OAUTH_DUMMY_KEY` 상수
    (`"opencode-oauth-dummy-key"`).
  - `packages/opencode/src/auth/index.ts:9` — `auth.json` 파일 경로
    (`path.join(Global.Path.data, "auth.json")`, 0o600 모드).
  - `packages/opencode/src/auth/index.ts:13-36` — `Auth.Info` 차별화
    유니온(`api` / `oauth` / `wellknown`).
  - `packages/opencode/src/auth/index.ts:59-63` —
    `OPENCODE_AUTH_CONTENT` 환경 오버라이드 로더.
  - `packages/opencode/src/global/index.ts:10-20` — `xdg-basedir`를
    통한 `Global.Path.data`.
  - `packages/opencode/src/provider/provider.ts:1212-1276` — 자격 증명
    우선순위 해결(env → auth.json → 플러그인 auth 로더 → 커스텀 로더).
  - `packages/opencode/src/provider/provider.ts:894-905` — `id`,
    `source`, `env`, `key`, `options`, `models`를 가진 `Provider.Info`
    스키마.
  - `packages/opencode/src/plugin/codex.ts:417-433` — Codex OAuth 리프레시
    패턴(§6.3.2 리프레시 의미의 참조, 프라미스 병합으로 우리가 고치는
    경쟁 조건 버그 제외).
  - `packages/opencode/src/plugin/github-copilot/copilot.ts:57-171` —
    Copilot 토큰 교환 패턴.
  - `packages/sdk/js/src/gen/sdk.gen.ts:753-762` — v1 SDK
    `client.provider.list()`(`GET /provider`).
  - `packages/sdk/js/src/gen/sdk.gen.ts:916-925` — v1 SDK
    `client.auth.set()`(`PUT /auth/{id}`).
  - `packages/sdk/js/src/gen/types.gen.ts:1514-1526` — `Provider`
    응답 타입(`key?: string`, `source: "env"|"config"|"custom"|"api"`).
  - Anthropic OAuth의 업스트림 제거: opencode 커밋 `1ac1a0287`
    ("anthropic legal requests"); deprecated된
    `opencode-anthropic-auth@0.0.13` npm 패키지는 §6.3.2에서 참조된 흐름
    형태를 보존하고 있다.
