// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// Lazily render a Vega-Lite spec an agent placed in a message.
//
// Kept out of the initial bundle for the same reason Mermaid is (see
// mermaid.ts): most conversations never contain a chart, and the renderer is
// far larger than everything else the message pipeline needs. The dynamic
// import below is what puts it in its own chunk — importing `vega-embed` at
// module scope would silently move all of it into first load, which
// scripts/check-bundle-size.mjs would then fail on.
//
// Vega-Lite rather than a hand-rolled chart because it is the same spec an
// agent would write anywhere else, so a spec is portable rather than being a
// Bivy-shaped dialect nothing else reads.

type VegaEmbed = (typeof import("vega-embed"))["default"];

let embedPromise: Promise<VegaEmbed> | null = null;

function loadVega(): Promise<VegaEmbed> {
  embedPromise ??= import("vega-embed").then(({ default: embed }) => embed);
  return embedPromise;
}

/** Read a design token's current value, so the chart tracks the app's theme
 *  rather than carrying a second palette that drifts from it. Vega needs real
 *  color values up front; it cannot resolve `var(--…)` itself. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export interface ChartResult {
  ok: boolean;
  /** Why it could not be drawn, for the caller to show in place of the chart. */
  reason?: string;
}

/**
 * Draw `spec` into `host`. Resolves when the chart is on screen, or with a
 * reason the caller can render instead — an invalid spec must read as a sentence
 * in the message, never as an exception that blanks it.
 *
 * `data.url` is refused: it would make the viewer's browser fetch a URL an agent
 * chose, which is the same SSRF/privacy hole the node avoids by fetching remote
 * markdown images server-side. Data belongs inline in the spec, where the whole
 * chart is one reviewable value.
 */
export async function renderChart(host: HTMLElement, spec: Record<string, unknown>): Promise<ChartResult> {
  const data = spec.data as { url?: unknown } | undefined;
  if (data && typeof data === "object" && "url" in data) {
    return { ok: false, reason: "A chart has to carry its own data; it cannot load a URL." };
  }
  let embed: VegaEmbed;
  try {
    embed = await loadVega();
  } catch {
    return { ok: false, reason: "The chart renderer could not be loaded." };
  }
  if (!host.isConnected) return { ok: false };

  const ink = token("--ink", "#1a1a1a");
  const muted = token("--muted", "#6b6b6b");
  const line = token("--line", "#e0e0e0");
  const accent = token("--accent", "#3b5bdb");
  try {
    // A MEASURED width, not `width: "container"`. With container sizing Vega
    // lays the chart out once at a default width to decide things like whether
    // axis labels fit, then resizes — so two short labels in a wide message
    // came out rotated 90°, having been judged against a width the chart never
    // had. Measuring first means it is laid out once, correctly.
    //
    // Defaults go first so an agent's spec can override any of them.
    const width = Math.max(120, host.clientWidth - 20);
    const fitted = { width, autosize: { type: "fit", contains: "padding" }, ...spec } as Parameters<VegaEmbed>[1];
    await embed(host, fitted, {
      actions: false,
      renderer: "svg",
      // No remote loading of any kind: a spec that slips a URL past the check
      // above still cannot reach the network from here.
      loader: { load: async () => { throw new Error("charts cannot load external data"); } } as never,
      config: {
        background: "transparent",
        // A real font stack, not "inherit": Vega measures label widths with a
        // canvas font string, and an unparseable one makes every label measure
        // wrong — which it resolves by rotating the axis labels 90° even when
        // they would have fitted easily.
        font: token("--font-sans", "system-ui, sans-serif"),
        view: { stroke: null },
        axis: { labelColor: muted, titleColor: ink, gridColor: line, domainColor: line, tickColor: line },
        // Horizontal category labels. Vega-Lite rotates a discrete x-axis 90°
        // by default, which is hard to read in a chat message and was happening
        // even for two short labels in a wide column. `labelOverlap` is left to
        // Vega, so a genuinely crowded axis drops labels rather than colliding —
        // and a spec that wants rotation can still set labelAngle itself.
        axisX: { labelAngle: 0, labelOverlap: "parity" },
        legend: { labelColor: muted, titleColor: ink },
        title: { color: ink },
        range: { category: [accent, token("--ok", "#2f9e44"), token("--warn", "#e8590c"), token("--danger", "#c92a2a"), muted] },
        mark: { color: accent },
      },
    });
    return { ok: true };
  } catch (error) {
    // Vega reports a malformed spec by throwing. Say so in a sentence; the
    // source stays in the message for the reader either way.
    return { ok: false, reason: error instanceof Error ? error.message : "This chart could not be drawn." };
  }
}
