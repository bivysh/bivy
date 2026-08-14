// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
import type { ReactNode } from "react";

export type SegmentedOption<T extends string> = { id: T; label: string; icon?: ReactNode };

/**
 * One canonical "pick one of N" control, card layout: a radiogroup of
 * `.selectable` cards (icon over label). Data-driven — pass `options` and it
 * renders anywhere, so surfaces don't re-implement the segmented markup or its
 * selected-state styling. See the design-system styleguide (Segmented).
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (id: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented-cards" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className="selectable"
          onClick={() => onChange(o.id)}
        >
          {o.icon && <span className="segmented-icon">{o.icon}</span>}
          <span className="segmented-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
