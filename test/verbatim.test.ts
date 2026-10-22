import { describe, expect, test } from "bun:test"
import { missingVerbatim } from "../src/verbatim"

describe("omission check", () => {
  test("reports the identifier line a translation dropped", () => {
    const source = "colus001@me.com / +821092836686\n\n이거 둘다 테스트핸들로 등록해줘"
    expect(missingVerbatim(source, "Please register both of these as test handles.")).toEqual([
      "colus001@me.com",
      "+821092836686",
    ])
    expect(
      missingVerbatim(source, "colus001@me.com / +821092836686\n\nPlease register both of these as test handles."),
    ).toEqual([])
  })

  test("checks URLs, paths, long numbers, and technical inline code", () => {
    const source = [
      "See https://github.com/ysm-dev/opencode-translate.",
      "Edit apps/api/src/conversations/reset.ts:49 and run `bun test`.",
      "Call `/reset` for ID 1792659474101, or 010-9283-6686.",
    ].join("\n")
    expect(missingVerbatim(source, "")).toEqual([
      "https://github.com/ysm-dev/opencode-translate",
      "apps/api/src/conversations/reset.ts",
      "1792659474101",
      "010-9283-6686",
      "/reset",
    ])
    const translated = [
      "https://github.com/ysm-dev/opencode-translate 를 참고하세요.",
      "apps/api/src/conversations/reset.ts:49를 수정하고 `bun test`를 실행하세요.",
      "ID 1792659474101 또는 010-9283-6686에 대해 `/reset`을 호출하세요.",
    ].join("\n")
    expect(missingVerbatim(source, translated)).toEqual([])
  })

  test("allows what a translation may legitimately change", () => {
    // Ordinary words, including the PascalCase words the old placeholder pipeline stranded.
    expect(missingVerbatim("What about the Backup?", "백업은요?")).toEqual([])
    // Labels in backticks.
    expect(
      missingVerbatim("Click `Save`, then `Open...`, then `저장`.", "`저장`, `열기...`, `Save`를 클릭하세요."),
    ).toEqual([])
    // Dates and quantities.
    expect(
      missingVerbatim("Released 2026-10-22 with 1,500,000 downloads and 1500000 views.", "2026년 10월 22일, 150만 건"),
    ).toEqual([])
    // Slashes in prose.
    expect(missingVerbatim("Use and/or, TCP/IP, and 24/7 support.", "및/또는, TCP/IP, 연중무휴 지원")).toEqual([])
    // Korean particles attached to the span, and emphasis around it.
    expect(
      missingVerbatim(
        "**colus001@me.com**이 src/index.ts를 https://example.com에서 열었어",
        "colus001@me.com opened src/index.ts at https://example.com",
      ),
    ).toEqual([])
    // Regrouped phone numbers, and inline code that lost only its backticks.
    expect(missingVerbatim("+821092836686", "+82 10-9283-6686")).toEqual([])
    expect(missingVerbatim("Run `/reset`.", "/reset을 실행하세요.")).toEqual([])
  })
})
