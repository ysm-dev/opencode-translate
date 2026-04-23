import { PLACEHOLDER_PATTERN } from "./constants"

type Segment = { type: "text"; value: string } | { type: "placeholder"; value: string }

interface PlaceholderEntry {
  token: string
  kind: string
  original: string
}

export interface ProtectionPlan {
  text: string
  placeholders: PlaceholderEntry[]
  counts: {
    fencedCodeBlocks: number
    urls: number
    paths: number
  }
}

export interface RestoreFailure {
  ok: false
  missing: string[]
  extra: string[]
  duplicated: string[]
  reason: string
}

export interface RestoreSuccess {
  ok: true
  text: string
}

export type RestoreResult = RestoreSuccess | RestoreFailure

const RELATIVE_PATH_EXTENSIONS = [
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "md",
  "py",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
  "zsh",
].join("|")

function placeholderToken(kind: string, index: number): string {
  return `⟦OCTX:${kind}:${index}⟧`
}

function replaceWithPlaceholders(
  segments: Segment[],
  kind: string,
  expression: RegExp,
  startIndex: number,
  filter?: (match: string) => boolean,
): { segments: Segment[]; nextIndex: number } {
  let nextIndex = startIndex
  const nextSegments: Segment[] = []

  for (const segment of segments) {
    if (segment.type === "placeholder") {
      nextSegments.push(segment)
      continue
    }

    const source = segment.value
    expression.lastIndex = 0
    let cursor = 0
    let matched = false
    let match = expression.exec(source)

    while (match !== null) {
      const value = match[0]
      if (!value) {
        expression.lastIndex += 1
        match = expression.exec(source)
        continue
      }
      if (filter && !filter(value)) {
        match = expression.exec(source)
        continue
      }

      matched = true
      if (match.index > cursor) {
        nextSegments.push({ type: "text", value: source.slice(cursor, match.index) })
      }

      const token = placeholderToken(kind, nextIndex)
      nextSegments.push({ type: "placeholder", value: JSON.stringify({ token, kind, original: value }) })
      nextIndex += 1
      cursor = match.index + value.length
      match = expression.exec(source)
    }

    if (!matched) {
      nextSegments.push(segment)
      continue
    }

    if (cursor < source.length) {
      nextSegments.push({ type: "text", value: source.slice(cursor) })
    }
  }

  return { segments: nextSegments, nextIndex }
}

function deserializeSegments(segments: Segment[]): { plain: string; placeholders: PlaceholderEntry[] } {
  const placeholders: PlaceholderEntry[] = []
  const plain = segments
    .map((segment) => {
      if (segment.type === "text") return segment.value
      const record = JSON.parse(segment.value) as PlaceholderEntry
      placeholders.push(record)
      return record.token
    })
    .join("")

  return { plain, placeholders }
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0
  let count = 0
  while (pattern.exec(text)) count += 1
  return count
}

function countPaths(text: string): number {
  const patterns = [
    /(?<![A-Za-z0-9_.~-])\/[A-Za-z0-9._~\-/]+/g,
    /(?<![A-Za-z0-9_.~-])[A-Za-z]:\\[^\s"'`<>]+/g,
    new RegExp(
      `${String.raw`(?<![A-Za-z0-9_.~\-/])(?:\.\.?[\\/])?(?:[^\s"'`}\`${String.raw`<>]+[\\/])+[^\s"'`}\`${String.raw`<>]+\.(?:${RELATIVE_PATH_EXTENSIONS})\b`}`,
      "g",
    ),
  ]

  return patterns.reduce((sum, pattern) => sum + countMatches(text, pattern), 0)
}

export function protectText(text: string): ProtectionPlan {
  let segments: Segment[] = [{ type: "text", value: text }]
  const placeholderEntries: PlaceholderEntry[] = []
  let placeholderIndex = 0
  let fencedCodeBlocks = 0
  let urls = 0
  let paths = 0

  const apply = (kind: string, expression: RegExp, filter?: (match: string) => boolean) => {
    const result = replaceWithPlaceholders(segments, kind, expression, placeholderIndex, filter)
    segments = result.segments
    placeholderIndex = result.nextIndex
  }

  apply("fenced-code", /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?\n(?:```|~~~)(?=\n|$)/g)
  apply("inline-code", /`[^`\n]+`/g)
  apply("url", /(?:https?:\/\/|wss?:\/\/|file:\/\/|mailto:)[^\s<>()]+/g)
  apply("path-posix", /(?<![A-Za-z0-9_.~-])\/[A-Za-z0-9._~\-/]+/g)
  apply("path-windows", /(?<![A-Za-z0-9_.~-])[A-Za-z]:\\[^\s"'`<>]+/g)
  apply(
    "path-relative",
    new RegExp(
      `${String.raw`(?<![A-Za-z0-9_.~\-/])(?:\.\.?[\\/])?(?:[^\s"'`}\`${String.raw`<>]+[\\/])+[^\s"'`}\`${String.raw`<>]+\.(?:${RELATIVE_PATH_EXTENSIONS})\b`}`,
      "g",
    ),
  )
  apply("env", /\$(?:\{[A-Z_][A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*)|%[A-Z_][A-Z0-9_]*%/g)
  apply("stack-frame", /^(?: {0,4}at .+?:\d+:\d+.*)$/gm)
  apply(
    "diff",
    /^(?:(?:@@ .*)|(?:\+\+\+ .*)|(?:--- .*)|(?:\+.*)|(?:-.*))(?:\n(?:(?:@@ .*)|(?:\+\+\+ .*)|(?:--- .*)|(?:\+.*)|(?:-.*)))*$/gm,
  )
  apply("json-key", /(?<=^|\n)[ \t]*(?:"[^"\n]+"|'[^'\n]+'|[A-Za-z0-9_.-]+)(?=:\s*)/g)
  apply("tag", /<[^>\n]+>/g)
  apply("prompt-marker", /<!-- oc-translate:[^>\n]*-->/g)
  apply("reference", /(?:@[A-Za-z0-9_.-]+|#[0-9]+|\b[0-9a-f]{7,40}\b)/g)
  apply(
    "identifier",
    /\b(?:[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*|[a-z0-9]+(?:_[a-z0-9]+)+|[a-z0-9]+(?:-[a-z0-9]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+)\b/g,
    (match) => match.length >= 3,
  )

  const { plain, placeholders } = deserializeSegments(segments)
  placeholderEntries.push(...placeholders)
  fencedCodeBlocks = countMatches(text, /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?\n(?:```|~~~)(?=\n|$)/g)
  urls = countMatches(text, /(?:https?:\/\/|wss?:\/\/|file:\/\/|mailto:)[^\s<>()]+/g)
  paths = countPaths(text)

  return {
    text: plain,
    placeholders: placeholderEntries,
    counts: {
      fencedCodeBlocks,
      urls,
      paths,
    },
  }
}

export function restoreProtectedText(plan: ProtectionPlan, translated: string): RestoreResult {
  const placeholders = translated.match(PLACEHOLDER_PATTERN) ?? []
  const counts = new Map<string, number>()
  for (const token of placeholders) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  const expected = new Set(plan.placeholders.map((entry) => entry.token))
  const missing = plan.placeholders.map((entry) => entry.token).filter((token) => counts.get(token) !== 1)
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([token]) => token)
  const extra = [...counts.keys()].filter((token) => !expected.has(token))

  if (missing.length > 0 || duplicated.length > 0 || extra.length > 0) {
    return {
      ok: false,
      missing,
      duplicated,
      extra,
      reason: "placeholder mismatch",
    }
  }

  let restored = translated
  for (const entry of plan.placeholders) {
    restored = restored.replaceAll(entry.token, entry.original)
  }

  if (
    countMatches(restored, /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?\n(?:```|~~~)(?=\n|$)/g) !== plan.counts.fencedCodeBlocks
  ) {
    return {
      ok: false,
      missing: [],
      duplicated: [],
      extra: [],
      reason: "fenced code block count mismatch",
    }
  }

  if (countMatches(restored, /(?:https?:\/\/|wss?:\/\/|file:\/\/|mailto:)[^\s<>()]+/g) !== plan.counts.urls) {
    return {
      ok: false,
      missing: [],
      duplicated: [],
      extra: [],
      reason: "url count mismatch",
    }
  }

  if (countPaths(restored) !== plan.counts.paths) {
    return {
      ok: false,
      missing: [],
      duplicated: [],
      extra: [],
      reason: "path count mismatch",
    }
  }

  return {
    ok: true,
    text: restored,
  }
}
