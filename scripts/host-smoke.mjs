import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

// An isolated real OpenCode server, a local fake provider, and real SQLite. No
// user configuration, credentials, sessions, or external model requests are used.
const root = await mkdtemp(path.join(process.env.OPENCODE_TRANSLATE_TEST_TMP ?? tmpdir(), "translate-host-"))
const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url))
const requests = []
let key = "test-sqlite-key"
let child
let logs = ""
const provider = createServer(async (req, res) => {
  let text = ""
  for await (const chunk of req) text += chunk
  const input = JSON.parse(text)
  requests.push({ input, authorization: req.headers.authorization })
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401).end("Unexpected credential")
    return
  }
  const serialized = JSON.stringify(input.messages)
  const content =
    input.model === "translator"
      ? serialized.includes("from Korean to English")
        ? "Hello"
        : "안녕하세요"
      : "Hello from the assistant"
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(
    `${[
      { id: "chat_test", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
      {
        id: "chat_test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")}data: [DONE]\n\n`,
  )
})

async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const force = setTimeout(() => child.kill("SIGKILL"), 5000)
  await exited
  clearTimeout(force)
}

try {
  await Promise.all(["config", "project", "cache", "data", "state"].map((name) => mkdir(path.join(root, name))))
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  const providerURL = `http://127.0.0.1:${provider.address().port}/v1`
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: path.dirname(entrypoint), options: { model: "translate-test/translator", lang: "Korean" } }],
    model: "translate-test/main",
    snapshots: false,
    providers: {
      "translate-test": {
        name: "Isolated test provider",
        package: "@opencode/ai/providers/openai/chat",
        settings: { baseURL: providerURL },
        models: { main: {}, translator: {} },
      },
    },
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OPENCODE_")))
  await writeFile(path.join(root, "config", "opencode.json"), JSON.stringify(config))
  Object.assign(env, {
    HOME: root,
    OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_CONFIG: path.join(root, "config", "opencode.json"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_FFF: "true",
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_PASSWORD: "isolated-test",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  })
  let address
  async function api(route, body) {
    const url = new URL(route, address)
    url.searchParams.set("location[directory]", path.join(root, "project"))
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Basic ${Buffer.from("opencode:isolated-test").toString("base64")}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${route}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  async function start() {
    const reservation = createServer()
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    address = `http://127.0.0.1:${port}`
    child = spawn(
      process.env.OPENCODE_BINARY ?? "opencode2",
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: path.join(root, "project"), env, stdio: ["ignore", "pipe", "pipe"] },
    )
    child.stdout.on("data", (data) => {
      logs += data
    })
    child.stderr.on("data", (data) => {
      logs += data
    })
    let failure
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`)
      try {
        await api("/api/plugin/await-activation", {}).catch((error) => {
          if (!String(error).includes(": 404")) throw error
        })
        const plugins = await api("/api/plugin")
        if (
          plugins.data?.some(
            (plugin) => plugin.id === "opencode-translate" && (!plugin.state || plugin.state.status === "active"),
          )
        )
          return
        failure = new Error(
          `Plugin not active: ${JSON.stringify(plugins.data?.filter((plugin) => plugin.source.type !== "builtin"))}`,
        )
      } catch (error) {
        failure = error
      }
      await sleep(200)
    }
    console.error("Config diagnostics:", await api("/api/config").catch(String))
    throw failure
  }
  await start()
  const plugins = await api("/api/plugin")
  assert(
    plugins.data.some(
      (plugin) => plugin.id === "opencode-translate" && (!plugin.state || plugin.state.status === "active"),
    ),
    JSON.stringify(plugins),
  )
  await api("/api/integration/translate-test/connect/key", { key })
  const db = new DatabaseSync(path.join(root, "opencode.db"), { readOnly: true })
  const credential = db.prepare("SELECT value FROM credential WHERE integration_id = ?").get("translate-test")
  assert.equal(JSON.parse(credential.value).key, key)
  db.close()
  const created = await api("/api/session", {
    title: "Translation smoke test",
    location: { directory: path.join(root, "project") },
    model: { providerID: "translate-test", id: "main" },
  })
  const sessionID = created.data.id
  await api(`/api/session/${sessionID}/prompt`, { text: "$en 안녕하세요" })
  await api(`/api/session/${sessionID}/wait`, {})
  const first = await api(`/api/session/${sessionID}/context`)
  assert(
    first.data.some((message) => message.type === "user" && message.text.includes("→ EN: Hello")),
    JSON.stringify(first),
  )
  assert(
    first.data.some(
      (message) =>
        message.type === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text.includes("안녕하세요")),
    ),
    JSON.stringify(first),
  )
  assert(requests.some(({ input }) => input.model === "translator"))
  assert(
    requests
      .filter(({ input }) => input.model === "main")
      .every(({ input }) => !JSON.stringify(input.messages).includes("안녕하세요")),
  )
  await stop()
  await start()
  key = "rotated-sqlite-key"
  await api("/api/integration/translate-test/connect/key", { key })
  const before = requests.length
  await api(`/api/session/${sessionID}/prompt`, { text: "다음 질문" })
  await api(`/api/session/${sessionID}/wait`, {})
  const next = requests.slice(before)
  assert(
    next.some(({ input }) => input.model === "translator"),
    "activation must survive restart",
  )
  assert(
    next.every((request) => request.authorization === `Bearer ${key}`),
    "must use the rotated SQLite credential",
  )
  assert(
    next
      .filter(({ input }) => input.model === "main")
      .every(({ input }) => !/[가-힣]/.test(JSON.stringify(input.messages))),
    "history sent to main model must be English",
  )
  console.log(
    "Real OpenCode smoke passed: plugin activation, SQLite credentials/rotation, bilingual persisted transcript, English model context, restart recovery.",
  )
} catch (error) {
  console.error(logs)
  throw error
} finally {
  await stop()
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  await rm(root, { recursive: true, force: true })
}
