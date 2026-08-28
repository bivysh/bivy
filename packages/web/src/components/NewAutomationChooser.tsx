// SPDX-License-Identifier: AGPL-3.0-only

import { useMemo, useState } from "react";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automationTemplates.js";
import { IconBolt, IconBug, IconCi, IconFlask, IconPackage, IconPr, IconRadar, IconShield, IconSpark } from "./AutomationIcons.js";

function triggerBadge(template: AutomationTemplate): { label: string; tone: string } {
  if (template.kind === "schedule") return { label: "Schedule", tone: "schedule" };
  if (template.kind === "webhook") return { label: "Webhook", tone: "webhook" };
  if (template.kind === "source") {
    if (template.trigger === "linear") return { label: "Linear", tone: "linear" };
    if (template.trigger === "github_ci") return { label: "CI", tone: "github" };
    return { label: "GitHub", tone: "github" };
  }
  return { label: "Setup", tone: "manual" };
}

function templateIcon(key: string) {
  switch (key) {
    case "upgrade-dependencies": return <IconPackage />;
    case "dependency-security-audit": return <IconShield />;
    case "lint-format-autofix": return <IconSpark />;
    case "flaky-test-triage": return <IconFlask />;
    case "fix-failed-ci": return <IconCi />;
    case "fix-error-tracker-issue": return <IconBug />;
    case "investigate-production-errors": return <IconRadar />;
    case "work-issues-into-prs":
    case "work-linear-issues-into-prs": return <IconPr />;
    default: return <IconBolt />;
  }
}

const TEMPLATE_GROUPS: Array<{ id: string; label: string; match: (t: AutomationTemplate) => boolean }> = [
  { id: "events", label: "From GitHub & Linear", match: (t) => t.kind === "source" },
  { id: "schedule", label: "On a schedule", match: (t) => t.kind === "schedule" },
  { id: "webhook", label: "From a webhook", match: (t) => t.kind === "webhook" },
];

export function NewAutomationChooser({
  onClose,
  onScratch,
  onTemplate,
}: {
  onClose: () => void;
  onScratch: () => void;
  onTemplate: (t: AutomationTemplate) => void;
}) {
  return (
    <div className="wizard-scrim" onClick={onClose}>
      <div
        className="wizard autom-editor autom-chooser"
        role="dialog"
        aria-modal="true"
        aria-label="New automation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wizard-head">
          <div className="wq-head-text">
            <strong>New automation</strong>
            <span className="wq-head-sub">Pick a starting point</span>
          </div>
          <button type="button" className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="wizard-body autom-chooser-body">
          <NewAutomationPicker onScratch={onScratch} onTemplate={onTemplate} />
        </div>
      </div>
    </div>
  );
}

export function NewAutomationPicker({
  onScratch,
  onTemplate,
}: {
  onScratch: () => void;
  onTemplate: (t: AutomationTemplate) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return AUTOMATION_TEMPLATES;
    return AUTOMATION_TEMPLATES.filter((t) => {
      const hay = `${t.title} ${t.tagline} ${t.key}`.toLowerCase();
      return hay.includes(q);
    });
  }, [q]);

  const groups = useMemo(() => {
    return TEMPLATE_GROUPS
      .map((g) => ({ ...g, items: filtered.filter(g.match) }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  const ungrouped = useMemo(() => {
    const claimed = new Set(groups.flatMap((g) => g.items.map((t) => t.key)));
    return filtered.filter((t) => !claimed.has(t.key));
  }, [filtered, groups]);

  return (
    <div className="autom-picker">
      <button type="button" className="autom-scratch-row" onClick={onScratch}>
        <span className="autom-scratch-icon" aria-hidden="true"><IconBolt /></span>
        <span className="autom-scratch-text">
          <strong>Start from scratch</strong>
          <span>Blank automation — pick the trigger, write the instructions</span>
        </span>
        <span className="autom-scratch-chevron" aria-hidden="true">→</span>
      </button>

      <div className="autom-picker-templates-head">
        <h3 className="autom-section-label" style={{ margin: 0 }}>Templates</h3>
        <input
          className="autom-picker-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates…"
          aria-label="Search templates"
          autoComplete="off"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="settings-hint autom-empty-hint">No templates match “{query.trim()}”.</p>
      ) : (
        <>
          {groups.map((g) => (
            <div className="autom-picker-group" key={g.id}>
              <h4 className="autom-picker-group-label">{g.label}</h4>
              <div className="automation-templates">
                {g.items.map((template) => (
                  <TemplateCard key={template.key} template={template} onUse={() => onTemplate(template)} />
                ))}
              </div>
            </div>
          ))}
          {ungrouped.length > 0 && (
            <div className="autom-picker-group">
              <div className="automation-templates">
                {ungrouped.map((template) => (
                  <TemplateCard key={template.key} template={template} onUse={() => onTemplate(template)} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TemplateCard({ template, onUse }: { template: AutomationTemplate; onUse: () => void }) {
  const badge = triggerBadge(template);
  const cta = template.kind === "source" ? (template.cta || "Set up") : "Use";
  return (
    <button type="button" className="template-card" onClick={onUse}>
      <div className="template-card-top">
        <span className="template-card-icon" aria-hidden="true">{templateIcon(template.key)}</span>
        <span className={`template-card-badge tone-${badge.tone}`}>{badge.label}</span>
      </div>
      <strong className="template-card-title">{template.title}</strong>
      <p className="template-card-tagline">{template.tagline}</p>
      <span className="template-card-cta">{cta} →</span>
    </button>
  );
}
