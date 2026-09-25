import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const temp = await mkdtemp(path.join(tmpdir(), "opencode-translate-package-"))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  const output = run("npm", ["pack", "--silent", "--json", "--pack-destination", temp], root)
  const jsonStart = output.lastIndexOf("\n[")
  const [packed] = JSON.parse(output.slice(jsonStart === -1 ? 0 : jsonStart + 1))
  const paths = packed.files.map((file) => file.path)

  assert(paths.includes("dist/index.js"), "package must contain the compiled entrypoint")
  assert(paths.includes("index.d.ts"), "package must contain its public type declarations")
  assert(!paths.some((file) => file.endsWith(".ts") && file !== "index.d.ts"), "package must not contain TS source")

  const consumer = path.join(temp, "consumer")
  await mkdir(consumer)
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n')

  const tarball = path.join(temp, packed.filename)
  run("npm", ["install", "--silent", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumer)
  run(
    "node",
    [
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict"
        process.env.OPENCODE_TRANSLATE_DISABLE = "1"
        const plugin = await import("opencode-translate")
        assert.equal(plugin.default.id, "opencode-translate")
        assert.equal(typeof plugin.default.setup, "function")
        assert.equal(plugin.default, plugin.OpencodeTranslate)
        assert.equal(await plugin.default.setup({}), undefined)
        delete process.env.OPENCODE_TRANSLATE_DISABLE
        const hooks = []
        const hook = (domain) => async (name) => {
          hooks.push(domain + "." + name)
          return { dispose: async () => {} }
        }
        const cleanup = await plugin.default.setup({
          app: { version: "2.0.3" },
          options: { model: "openai/gpt-5.4-mini", lang: "Korean" },
          session: { hook: hook("session") },
          tool: { hook: hook("tool") },
          aisdk: { hook: hook("aisdk") },
          storage: {},
          generate: {},
        })
        assert(hooks.includes("session.prompt"))
        assert(hooks.includes("session.http.response"))
        assert(hooks.includes("aisdk.language"))
        assert(hooks.includes("session.compaction"))
        assert(hooks.includes("tool.execute.after"))
        assert.equal(typeof cleanup, "function")
        await cleanup()
      `,
    ],
    consumer,
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
