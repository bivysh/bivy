// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  LOCAL_DISCOVERY_CANDIDATES,
  discoverLocalModels,
  getLocalModelReadiness,
  isLoopbackHostname,
  normalizeCatalog,
  validateLocalEndpointUrl,
  verifyLocalModelEndpoint,
} from "../src/runtime/local-model-discovery.js";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("local model discovery security", () => {
  it("uses a finite loopback-only allowlist", () => {
    assert.deepEqual(LOCAL_DISCOVERY_CANDIDATES.map((candidate) => new URL(candidate.catalogUrl).hostname), [
      "127.0.0.1", "127.0.0.1", "127.0.0.1", "127.0.0.1",
    ]);
    assert.deepEqual(LOCAL_DISCOVERY_CANDIDATES.map((candidate) => new URL(candidate.catalogUrl).port), ["11434", "1234", "8000", "30000"]);
    assert.equal(isLoopbackHostname("::ffff:7f00:1"), true);
  });

  it("never expands discovery from response data", async () => {
    const requested: string[] = [];
    await discoverLocalModels({ fetchImpl: (async (url) => {
      requested.push(String(url));
      return json({ data: [], next: "http://192.168.1.1/models" });
    }) as typeof fetch });
    assert.deepEqual(requested, LOCAL_DISCOVERY_CANDIDATES.map((candidate) => candidate.catalogUrl));
  });

  it("defaults custom verification to loopback and rejects unsafe URLs", async () => {
    await assert.rejects(validateLocalEndpointUrl("file:///etc/passwd"), /http:\/\/ or https:\/\//);
    await assert.rejects(validateLocalEndpointUrl("http://user:pass@localhost:8000/v1"), /cannot contain credentials/);
    await assert.rejects(validateLocalEndpointUrl("https://example.com/v1"), /limited to this Machine/);
    await assert.rejects(validateLocalEndpointUrl("http://169.254.169.254/v1", { allowNonLoopback: true }), /blocked/);
    await assert.rejects(validateLocalEndpointUrl("https://models.example/v1", {
      allowNonLoopback: true,
      lookup: async () => [{ address: "::ffff:a9fe:a9fe", family: 6 }],
    }), /blocked/);
    await assert.rejects(validateLocalEndpointUrl("https://models.example/v1", {
      allowNonLoopback: true,
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    }), /blocked/);
  });
});

describe("local model catalog normalization", () => {
  it("handles OpenAI and Ollama catalogs and deduplicates bounded model ids", () => {
    assert.deepEqual(normalizeCatalog({ data: [{ id: "qwen" }, { id: "qwen" }, { nope: true }, { id: "llama" }] }, "openai"),
      [{ id: "qwen", name: "qwen" }, { id: "llama", name: "llama" }]);
    assert.deepEqual(normalizeCatalog({ models: [{ name: "gemma:latest" }, { model: "phi" }] }, "ollama"),
      [{ id: "gemma:latest", name: "gemma:latest" }, { id: "phi", name: "phi" }]);
    assert.equal(normalizeCatalog({ data: Array.from({ length: 250 }, (_, id) => ({ id: String(id) })) }, "openai").length, 200);
  });

  it("reports malformed and version-drift payloads honestly", async () => {
    const [result] = await discoverLocalModels({ fetchImpl: (async () => json({ objects: [] })) as typeof fetch });
    assert.equal(result.status, "malformed");
    assert.deepEqual(result.models, []);
    assert.match(result.detail ?? "", /different version/);
  });

  it("bounds catalog response bytes", async () => {
    const result = await verifyLocalModelEndpoint({
      baseUrl: "http://localhost:8000/v1",
      fetchImpl: (async () => new Response("x", { headers: { "content-length": String(600 * 1024) } })) as typeof fetch,
    });
    assert.equal(result.status, "malformed");
    assert.match(result.detail ?? "", /too large/);
  });
});

describe("local model endpoint health", () => {
  it("uses the guarded production dispatcher for a real loopback catalog", async () => {
    const server = createServer((request, response) => {
      assert.equal(request.url, "/v1/models");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-coder" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const result = await verifyLocalModelEndpoint({ baseUrl: `http://127.0.0.1:${address.port}/v1` });
      assert.equal(result.status, "ready");
      assert.deepEqual(result.models, [{ id: "local-coder", name: "local-coder" }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("distinguishes auth-required and authenticated readiness", async () => {
    const authRequired = await verifyLocalModelEndpoint({
      baseUrl: "http://localhost:8000/v1",
      fetchImpl: (async () => new Response("", { status: 401 })) as typeof fetch,
    });
    assert.equal(authRequired.status, "auth_required");

    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
      return json({ data: [{ id: "coder" }] });
    }) as typeof fetch;
    const ready = await verifyLocalModelEndpoint({ baseUrl: "http://localhost:8000/v1", apiKey: "secret", fetchImpl });
    assert.equal(ready.status, "ready");
    assert.equal(ready.authenticated, true);
    assert.deepEqual(ready.models, [{ id: "coder", name: "coder" }]);
  });

  it("distinguishes offline and unsupported catalogs", async () => {
    const offline = await verifyLocalModelEndpoint({
      baseUrl: "http://localhost:8000/v1",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
    });
    assert.equal(offline.status, "offline");
    const unsupported = await verifyLocalModelEndpoint({
      baseUrl: "http://localhost:8000/v1",
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    assert.equal(unsupported.status, "unsupported");
  });

  it("enforces the timeout when a fetch implementation ignores abort", async () => {
    const started = Date.now();
    const result = await verifyLocalModelEndpoint({
      baseUrl: "http://localhost:8000/v1",
      timeoutMs: 50,
      fetchImpl: (() => new Promise<Response>(() => undefined)) as typeof fetch,
    });
    assert.equal(result.status, "timeout");
    assert.ok(Date.now() - started < 500);
  });

  it("projects stable readiness without counting duplicates twice", () => {
    assert.deepEqual(getLocalModelReadiness([
      { baseUrl: "http://localhost/v1", api: "openai-completions", status: "ready", models: [{ id: "a", name: "a" }, { id: "a", name: "a" }] },
    ]), { ready: true, readyEndpointCount: 1, modelCount: 1, state: "ready" });
    assert.deepEqual(getLocalModelReadiness([
      { baseUrl: "http://localhost/v1", api: "openai-completions", status: "auth_required", models: [] },
    ]), { ready: false, readyEndpointCount: 0, modelCount: 0, state: "auth_required" });
  });
});
