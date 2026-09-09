/**
 * Compile-time guard for the published type declaration.
 *
 * `index.d.ts` is hand-written and shipped to consumers instead of `main`
 * (see `types` in package.json); nothing else ties it to the real
 * implementation in `src/index.ts`. `bun run typecheck` includes this file
 * (via the `test/**\/*.ts` glob in tsconfig.json), so a renamed, added,
 * removed, or retyped export in either file fails the build here instead of
 * shipping silently to consumers.
 *
 * This file has no `test()` calls — it is a compile-time-only check. Under
 * `bun test` it is collected but contributes 0 assertions; the real
 * enforcement happens in `bun run typecheck`.
 */
type SourceTypes = typeof import("../../src/index")
type PublishedTypes = typeof import("../../index")

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type PublicApiMatchesSource = AssertExact<SourceTypes, PublishedTypes>

// If this line reports a type error, `index.d.ts` no longer matches the
// exports of `src/index.ts` — update whichever one is stale.
const publicApiMatchesSource: PublicApiMatchesSource = true
void publicApiMatchesSource
