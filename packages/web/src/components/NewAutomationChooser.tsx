// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from "react";
import { useModalBack, useModalEscape } from "../modalStack.js";
import { useModalFocus } from "../useModalFocus.js";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./automationTemplates.js";
import { ChevronRightIcon, PlusIcon } from "./UiIcons.js";

type Props = { onScratch: () => void; onTemplate: (template: AutomationTemplate) => void };

export function NewAutomationChooser({ onClose, onScratch, onTemplate }: Props & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  const selectionAfterClose = useRef<(() => void) | null>(null);
  const closeWithBack = useModalBack(() => {
    const selection = selectionAfterClose.current;
    selectionAfterClose.current = null;
    onClose();
    selection?.();
  });
  useModalEscape(closeWithBack);
  function select(selection: () => void) {
    // Consume this history entry before mounting the editor's entry.
    selectionAfterClose.current = selection;
    closeWithBack();
  }
  return <div className="wizard-scrim" onClick={closeWithBack}>
    <div ref={ref} className="wizard autom-editor autom-chooser" role="dialog" aria-modal="true" aria-label="New automation" onClick={event => event.stopPropagation()}>
      <div className="wizard-head">
        <button type="button" className="btn ghost icon" onClick={closeWithBack} aria-label="Back to automations">‹</button>
        <strong>New automation</strong>
      </div>
      <div className="wizard-body autom-chooser-body">
        <NewAutomationPicker onScratch={() => select(onScratch)} onTemplate={template => select(() => onTemplate(template))} />
      </div>
    </div>
  </div>;
}

export function NewAutomationPicker({ onScratch, onTemplate }: Props) {
  return <div className="autom-picker">
    <section className="autom-field-block">
      <h2 className="autom-section-label">Start from scratch</h2>
      <button type="button" className="btn" onClick={onScratch}><PlusIcon /> New from scratch</button>
    </section>
    <section className="autom-field-block">
      <h2 className="autom-section-label">Start from template</h2>
      <div className="automation-template-rows">
        {AUTOMATION_TEMPLATES.map(template => <button type="button" className="automation-template-row" key={template.key} onClick={() => onTemplate(template)}>
          <span>{template.title}</span><ChevronRightIcon />
        </button>)}
      </div>
    </section>
  </div>;
}
