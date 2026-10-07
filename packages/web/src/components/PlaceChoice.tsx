// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { RunPlace } from "../onboarding.js";

const PLACES: { place: RunPlace; name: string; detail: string }[] = [
  { place: "cloud", name: "Bivy Cloud", detail: "Nothing to install. Agents keep working when your laptop is closed." },
  { place: "own", name: "My own computer", detail: "Your files, tools and logins. Your AI sign-ins stay on that computer." },
];

/** The first question after sign-in, when the deployment offers a cloud: where
 *  the user's agents run. The other option stays available later. */
export function PlaceChoice({ onChoose }: { onChoose: (place: RunPlace) => void }) {
  return (
    <section className="connect-runner" aria-labelledby="place-choice-title">
      <div className="connect-hero compact">
        <h2 className="connect-title" id="place-choice-title">Where should your agents run?</h2>
        <p className="connect-sub">You can add the other one later.</p>
      </div>
      <div className="connect-nodes-list">
        {PLACES.map(({ place, name, detail }) => (
          <button key={place} type="button" className="connect-node" onClick={() => onChoose(place)}>
            <span className="connect-node-text">
              <span className="connect-node-name">{name}</span>
              <span className="connect-node-detail">{detail}</span>
            </span>
            <svg className="connect-node-caret" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        ))}
      </div>
    </section>
  );
}
