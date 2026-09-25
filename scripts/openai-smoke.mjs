import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { multiAuthFixture } from "./fixtures/multi-auth.mjs"

// Real OpenCode, fake Responses + Chat endpoints, isolated HOME/credentials/DB.
// Run with Bun for the WebSocket-capable provider. No live accounts are used.
const english = "Hello from the assistant"
const translated = "안녕하세요 (translated)"
const label = "**Translation (Korean):**"
const plugin = process.env.OPENCODE_TRANSLATE_PACKAGE ?? fileURLToPath(new URL("../dist", import.meta.url))

function responses() {
  const item = {
    type: "message",
    role: "assistant",
    id: "msg_test",
    status: "completed",
    content: [{ type: "output_text", text: english, annotations: [], logprobs: [] }],
  }
  const response = {
    id: "resp_test",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: "main",
    output: [],
    status: "in_progress",
  }
  return [
    { type: "response.created", response },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: english,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: english,
      logprobs: [],
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ].map((event, sequence_number) => ({ ...event, sequence_number }))
}

function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

async function verify(mode, order) {
  const root = await mkdtemp(path.join(process.env.OPENCODE_TRANSLATE_TEST_TMP ?? tmpdir(), "translate-openai-"))
  const requests = []
  let leaked = false
  let sockets = 0
  let child
  let logs = ""
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      leaked ||= request.headers.has("x-opencode-translate-session")
      if (request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      const input = await request.json()
      requests.push(input)
      if (new URL(request.url).pathname.endsWith("/responses")) return sse(responses())
      const content = JSON.stringify(input.messages).includes("from Korean to English") ? "Hello" : translated
      return sse([
        { id: "chat_test", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] },
        {
          id: "chat_test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ])
    },
    websocket: {
      message(ws) {
        sockets++
        for (const event of responses()) ws.send(JSON.stringify(event))
      },
    },
  })
  try {
    await Promise.all(["config", "fake", "project", "cache", "data", "state"].map((dir) => mkdir(path.join(root, dir))))
    const translate = { package: plugin, options: { model: "translate-test/translator", lang: "Korean" } }
    const auth = { package: path.join(root, "fake") }
    const baseURL = `http://127.0.0.1:${provider.port}/v1`
    const sdkURL = import.meta.resolve("@ai-sdk/openai")
    await writeFile(path.join(root, "fake", "provider.mjs"), `export { createOpenAI } from ${JSON.stringify(sdkURL)};`)
    await writeFile(path.join(root, "fake", "index.js"), multiAuthFixture(sdkURL, mode === "host-fetch"))
    await writeFile(
      path.join(root, "config", "opencode.json"),
      JSON.stringify({
        plugins: mode === "native" ? [translate] : order === "translate-first" ? [translate, auth] : [auth, translate],
        snapshots: false,
        providers: {
          openai: { settings: { baseURL }, models: { main: {} } },
          "translate-test": {
            package: "@opencode/ai/providers/openai/chat",
            settings: { baseURL },
            models: { translator: {} },
          },
        },
      }),
    )
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_")))
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
    const reservation = createServer().listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    async function api(route, body) {
      const url = new URL(route, `http://127.0.0.1:${port}`)
      url.searchParams.set("location[directory]", path.join(root, "project"))
      const result = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Basic ${Buffer.from("opencode:isolated-test").toString("base64")}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const text = await result.text()
      assert(result.ok, `${route}: ${result.status} ${text}`)
      return text ? JSON.parse(text) : undefined
    }
    child = spawn(
      process.env.OPENCODE_BINARY ?? "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: path.join(root, "project"),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    child.stdout.on("data", (data) => {
      logs += data
    })
    child.stderr.on("data", (data) => {
      logs += data
    })
    let ready = false
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
      assert.equal(child.exitCode, null, logs)
      try {
        const plugins = (await api("/api/plugin")).data
        const ids = mode === "native" ? ["opencode-translate"] : ["opencode-translate", "test.multi-auth"]
        ready = ids.every((id) => plugins.some((p) => p.id === id && p.state.status === "active"))
      } catch {}
      if (!ready) await sleep(200)
    }
    assert(ready, "plugins must activate")
    await api("/api/integration/openai/connect/key", { key: "fake-openai" })
    await api("/api/integration/translate-test/connect/key", { key: "fake-translator" })
    const session = (
      await api("/api/session", {
        title: "OpenAI translation regression",
        location: { directory: path.join(root, "project") },
        model: { providerID: "openai", id: "main" },
      })
    ).data.id
    for (const prompt of ["$en 안녕하세요", "다음 질문"]) {
      await api(`/api/session/${session}/prompt`, { text: prompt })
      await api(`/api/experimental/session/${session}/wait`, {})
      const history = (await api(`/api/session/${session}/context`)).data
      assert(
        history
          .filter((m) => m.type === "user")
          .at(-1)
          .text.includes("→ EN: Hello"),
      )
      const text = history
        .filter((m) => m.type === "assistant")
        .at(-1)
        .content.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
      assert.equal(text, `${english}\n\n---\n\n${label}\n\n${translated}`)
    }
    assert.equal(sockets, 0, "native OpenAI must use HTTP even with its WebSocket default")
    assert.equal(leaked, false, "internal request tag must not reach the provider")
    const main = requests.filter((request) => request.model === "main")
    assert(main.length >= 2)
    assert(
      main.every((request) => !/[가-힣]/.test(JSON.stringify(request.input))),
      "follow-up context must be English-only",
    )
    console.log(`OpenAI smoke passed: ${mode}, ${order}, two bilingual turns, no duplicate trailer or leaked tag.`)
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      const force = setTimeout(() => child.kill("SIGKILL"), 5000)
      await exited
      clearTimeout(force)
    }
    provider.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}

await verify("native", "native")
for (const mode of ["own-fetch", "host-fetch"]) {
  for (const order of ["translate-first", "auth-first"]) await verify(mode, order)
}
