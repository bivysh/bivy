// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from "react";

/** A repository event filter is not an app permission or a user access list. */
export function RepositoryEventFilter({ value, onChange, github }: {
  value: string; onChange: (value: string) => void; github: boolean;
}) {
  const id = useId();
  return <div className="settings-field">
    <label className="field-label" htmlFor={id}>Limit to these repositories (optional)</label>
    <input id={id} className="picker-search" value={value} onChange={(event) => onChange(event.target.value)} placeholder="acme/website, acme/api" />
    <p className="settings-hint">{github
      ? "Leave blank for any repository the selected GitHub App can access. To accept events only from specific repositories, enter their owner/name, separated by commas. This filters events; it does not grant repository access."
      : "Leave blank for any repository. To limit which linked repositories can start this automation, enter their owner/name, separated by commas."}</p>
  </div>;
}
