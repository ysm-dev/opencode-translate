// Matches oc-codex-multi-auth 6.24.0's V2 integration without accounts or network
// access outside the fake provider. Both hook orders are exercised by the host test.
export function multiAuthFixture(sdkURL, hostFetch) {
  return `
import { createOpenAI } from ${JSON.stringify(sdkURL)};
const providerPackage = "aisdk:" + new URL("./provider.mjs", import.meta.url).href;
export default {
  id: "test.multi-auth",
  async setup(ctx) {
    await ctx.provider.transform((editor) => {
      editor.update("openai", (provider) => {
        provider.package = providerPackage;
        provider.activation = "enabled";
        provider.settings = { ...provider.settings, transport: "http" };
      });
      for (const model of editor.get("openai")?.models.values() ?? []) {
        editor.models.update("openai", model.id, (draft) => { draft.package = providerPackage; });
      }
    });
    await ctx.aisdk.hook("sdk", (event) => {
      const ownFetch = async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set("user-agent", "opencode/" + ctx.app.version);
        const body = await request.json();
        body.store = false;
        body.include = [...new Set([...(body.include ?? []), "reasoning.encrypted_content"])];
        return fetch(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
      };
      event.sdk = createOpenAI({ apiKey: "fake", baseURL: event.options.baseURL,
        fetch: ${hostFetch ? "event.options.fetch" : "ownFetch"} });
    }, { providerID: "openai" });
    await ctx.model.transform((editor) => {
      for (const model of editor.list("openai")) {
        editor.update("openai", String(model.id), (draft) => {
          draft.package = providerPackage;
          draft.settings = { ...draft.settings, transport: "http" };
        });
      }
    });
    await ctx.aisdk.hook("language", (event) => {
      const model = event.sdk.responses(event.model.modelID);
      event.language = new Proxy(model, {
        get(target, property, receiver) {
          if (property === "doGenerate" || property === "doStream") return (options) => {
            const openai = { ...options.providerOptions?.openai, store: false };
            delete openai.previousResponseId;
            delete openai.conversation;
            return target[property]({ ...options, providerOptions: { ...options.providerOptions, openai } });
          };
          return Reflect.get(target, property, receiver);
        },
      });
    }, { providerID: "openai" });
  },
};
`
}
