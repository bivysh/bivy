// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronRightIcon } from "./UiIcons.js";

export type SourceOverview = {
  name: string;
  status: { tone: "on" | "off" | "warn"; label: string };
  onClick: () => void;
};

/** One calm source summary, progressively disclosing individual setup rows. */
export function AutomationSourcesPanel({ sources }: { sources: SourceOverview[] }) {
  const connected = sources.filter((source) => source.status.tone === "on");
  const attention = sources.filter((source) => source.status.tone === "warn");
  const summary = attention.length
    ? `${attention.length} ${attention.length === 1 ? "source needs" : "sources need"} attention`
    : connected.length === sources.length
      ? `${connected.length} sources connected`
      : connected.length
        ? `${connected.map((source) => source.name).join(", ")} connected · ${sources.length - connected.length} more`
        : "Connect GitHub, Linear, and Slack";

  return (
    <details className="autom-sources-panel">
      <summary className="autom-sources-summary">
        <span className="autom-sources-summary-copy">
          <strong>Sources</strong>
          <span>{summary}</span>
        </span>
        <span className="autom-sources-chevron"><ChevronRightIcon /></span>
      </summary>
      <div className="autom-sources-list">
        {sources.map((source) => {
          const cta = source.status.tone === "off" ? "Connect" : source.status.tone === "warn" ? "Fix" : "Manage";
          return (
            <button type="button" className="autom-source-row" onClick={source.onClick} key={source.name}>
              <span className="autom-source-row-copy">
                <strong>{source.name}</strong>
                <span>{source.status.tone === "on" ? "Connected" : source.status.label}</span>
              </span>
              <span className="autom-source-row-cta">{cta}</span>
              <ChevronRightIcon size={16} />
            </button>
          );
        })}
      </div>
    </details>
  );
}
