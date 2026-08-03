// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  extractInlineImageUrls,
  assistantTextForImageScan,
  fetchInlineImage,
  isFetchImageError,
  inlineImageDisplayName,
  MAX_INLINE_IMAGES_PER_MESSAGE,
} from "../src/session/inline-image-fetch.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngBytes(extra = 32): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 1)]);
}

function neverCalled(name: string) {
  return async () => {
    throw new Error(`${name} should not have been called`);
  };
}

test("extractInlineImageUrls finds distinct https image URLs in first-seen order", () => {
  const text = "![a](https://x.test/a.png) prose ![b](https://x.test/b.png) ![a again](https://x.test/a.png)";
  assert.deepEqual(extractInlineImageUrls(text), ["https://x.test/a.png", "https://x.test/b.png"]);
});

test("extractInlineImageUrls ignores non-https images and caps at MAX_INLINE_IMAGES_PER_MESSAGE", () => {
  assert.deepEqual(extractInlineImageUrls("![a](http://x.test/a.png)"), []);
  const many = Array.from({ length: MAX_INLINE_IMAGES_PER_MESSAGE + 5 }, (_, i) => `![i${i}](https://x.test/${i}.png)`).join(" ");
  assert.equal(extractInlineImageUrls(many).length, MAX_INLINE_IMAGES_PER_MESSAGE);
});

test("assistantTextForImageScan reads plain-string and block-array content", () => {
  assert.equal(assistantTextForImageScan("![a](https://x.test/a.png)"), "![a](https://x.test/a.png)");
  assert.equal(
    assistantTextForImageScan([{ type: "text", text: "![a](https://x.test/a.png)" }, { type: "tool_use", input: {} }]),
    "![a](https://x.test/a.png)",
  );
  assert.equal(assistantTextForImageScan(null), "");
  assert.equal(assistantTextForImageScan(42), "");
});

test("fetchInlineImage rejects a non-https URL without ever fetching or resolving", async () => {
  const result = await fetchInlineImage("http://example.com/a.png", {
    fetchImpl: neverCalled("fetchImpl") as unknown as typeof fetch,
    resolveHost: neverCalled("resolveHost"),
  });
  assert.ok(isFetchImageError(result));
  assert.match((result as { error: string }).error, /https/i);
});

test("fetchInlineImage rejects a literal private/local host without fetching or resolving", async () => {
  for (const url of ["https://127.0.0.1/a.png", "https://169.254.169.254/latest/meta-data/", "https://localhost/a.png", "https://10.0.0.5/a.png"]) {
    const result = await fetchInlineImage(url, {
      fetchImpl: neverCalled("fetchImpl") as unknown as typeof fetch,
      resolveHost: neverCalled("resolveHost"),
    });
    assert.ok(isFetchImageError(result), `${url} should be rejected`);
    assert.match((result as { error: string }).error, /local|private/i);
  }
});

test("fetchInlineImage rejects a public-looking hostname that resolves to a private address (DNS rebinding)", async () => {
  let fetchCalled = false;
  const result = await fetchInlineImage("https://attacker.example/a.png", {
    fetchImpl: (async () => {
      fetchCalled = true;
      throw new Error("must not be reached");
    }) as unknown as typeof fetch,
    resolveHost: async () => ["169.254.169.254"],
  });
  assert.ok(isFetchImageError(result));
  assert.match((result as { error: string }).error, /resolves to a private/i);
  assert.equal(fetchCalled, false);
});

test("fetchInlineImage honors an explicit BIVY_INLINE_IMAGE_ALLOWED_HOSTS allowlist", async () => {
  const prev = process.env.BIVY_INLINE_IMAGE_ALLOWED_HOSTS;
  process.env.BIVY_INLINE_IMAGE_ALLOWED_HOSTS = "good.example";
  try {
    const rejected = await fetchInlineImage("https://bad.example/a.png", {
      fetchImpl: neverCalled("fetchImpl") as unknown as typeof fetch,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.ok(isFetchImageError(rejected));
    assert.match((rejected as { error: string }).error, /allowed_hosts/i);

    const accepted = await fetchInlineImage("https://good.example/a.png", {
      resolveHost: async () => ["93.184.216.34"],
      fetchImpl: (async () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
    });
    assert.ok(!isFetchImageError(accepted));
  } finally {
    if (prev === undefined) delete process.env.BIVY_INLINE_IMAGE_ALLOWED_HOSTS;
    else process.env.BIVY_INLINE_IMAGE_ALLOWED_HOSTS = prev;
  }
});

test("fetchInlineImage fetches a public host, sniffing the mime type over a lying Content-Type", async () => {
  const bytes = pngBytes();
  const result = await fetchInlineImage("https://cdn.example/chart.png", {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: (async () => new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } })) as unknown as typeof fetch,
  });
  assert.ok(!isFetchImageError(result));
  const ok = result as { bytes: Buffer; mimeType: string };
  assert.equal(ok.mimeType, "image/png");
  assert.deepEqual(Buffer.from(ok.bytes), bytes);
});

test("fetchInlineImage rejects a response with an oversized Content-Length up front", async () => {
  const result = await fetchInlineImage("https://cdn.example/big.png", {
    resolveHost: async () => ["93.184.216.34"],
    maxBytes: 100,
    fetchImpl: (async () =>
      new Response(pngBytes(1000), { status: 200, headers: { "content-type": "image/png", "content-length": "999999" } })) as unknown as typeof fetch,
  });
  assert.ok(isFetchImageError(result));
  assert.match((result as { error: string }).error, /too large/i);
});

test("fetchInlineImage enforces the size cap while streaming even without a truthful Content-Length", async () => {
  const maxBytes = 64;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Ten 16-byte chunks (160 bytes total) — well over the 64-byte cap, and no
      // Content-Length header at all, so only the streamed read can catch this.
      for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(16).fill(1));
      controller.close();
    },
  });
  const result = await fetchInlineImage("https://cdn.example/huge.png", {
    resolveHost: async () => ["93.184.216.34"],
    maxBytes,
    fetchImpl: (async () => new Response(stream, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
  });
  assert.ok(isFetchImageError(result));
  assert.match((result as { error: string }).error, /limit/i);
});

test("fetchInlineImage rejects a non-image response", async () => {
  const result = await fetchInlineImage("https://cdn.example/page.html", {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: (async () => new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
  });
  assert.ok(isFetchImageError(result));
  assert.match((result as { error: string }).error, /does not look like an image/i);
});

test("fetchInlineImage rejects an HTTP error status", async () => {
  const result = await fetchInlineImage("https://cdn.example/missing.png", {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
  });
  assert.ok(isFetchImageError(result));
  assert.match((result as { error: string }).error, /404/);
});

test("fetchInlineImage follows a redirect to a public host and re-validates it", async () => {
  let calls = 0;
  const result = await fetchInlineImage("https://short.example/r/abc", {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: (async (input: RequestInfo | URL) => {
      calls++;
      const url = String(input);
      if (url === "https://short.example/r/abc") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example/final.png" } });
      }
      assert.equal(url, "https://cdn.example/final.png");
      return new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch,
  });
  assert.ok(!isFetchImageError(result));
  assert.equal(calls, 2);
});

test("fetchInlineImage rejects a redirect whose target is a private/local host, without a second fetch", async () => {
  let calls = 0;
  const result = await fetchInlineImage("https://short.example/r/evil", {
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: (async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } });
    }) as unknown as typeof fetch,
  });
  assert.ok(isFetchImageError(result));
  assert.equal(calls, 1); // the second hop is rejected before ever being fetched
});

test("inlineImageDisplayName derives a name from the URL path, falling back to the mime type", () => {
  assert.equal(inlineImageDisplayName("https://cdn.example/dir/chart.png?x=1", "image/jpeg"), "chart.png");
  assert.equal(inlineImageDisplayName("https://cdn.example/", "image/webp"), "inline-image.webp");
  assert.equal(inlineImageDisplayName("not a url", "image/png"), "inline-image.png");
});
