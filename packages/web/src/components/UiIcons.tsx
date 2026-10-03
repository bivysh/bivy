// SPDX-License-Identifier: AGPL-3.0-only
import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & { size?: number };

const common = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function CloseIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

export function ChevronRightIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m9 18 6-6-6-6" /></svg>;
}

export function ChevronLeftIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m15 18-6-6 6-6" /></svg>;
}

export function ChevronUpIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m6 15 6-6 6 6" /></svg>;
}

export function ChevronDownIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m6 9 6 6 6-6" /></svg>;
}

export function MinusIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M5 12h14" /></svg>;
}

/** Terminal / shell prompt — the standalone-terminal glyph in the header. */
export function TerminalIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
}

/** Magnifying glass — search. */
export function SearchIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
}

/** Clipboard — paste. */
export function ClipboardIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /></svg>;
}

/** Overlapping documents — copy. */
export function CopyIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
}

/** Message bubble — the Composer toggle in the terminal toolbar. */
export function ChatBubbleIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /><path d="M8 9.5h8M8 13h5" /></svg>;
}

export function MoreIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
}

export function PlusIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M12 5v14M5 12h14" /></svg>;
}

export function CheckIcon({ size = 18, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m5 12 4 4L19 6" /></svg>;
}

/** Globe — a web view. */
export function GlobeIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
}

/** Monitor — a desktop app on its own display. */
export function DisplayIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
}

/** Chain link — a shareable link. */
export function LinkIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>;
}

/** House — a stable address for a home screen. */
export function HomeIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M4 11 12 4l8 7" /><path d="M6 10v10h12V10" /></svg>;
}

/** Stacked lines — output / logs. */
export function LogsIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M5 6h14M5 10h14M5 14h9M5 18h6" /></svg>;
}

/** Toothed wheel — settings. */
export function GearIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><circle cx="12" cy="12" r="6.4" /><circle cx="12" cy="12" r="2.5" /><path d="M12 4v1.6M12 18.4V20M4 12h1.6M18.4 12H20M6.3 6.3l1.2 1.2M16.5 16.5l1.2 1.2M17.7 6.3l-1.2 1.2M7.5 16.5l-1.2 1.2" /></svg>;
}

/** A page with a plus and a minus — changed files. */
export function DiffIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 10v6M9 13h6M9 18h6" /></svg>;
}

/** A window with its right column marked — show or hide a side pane. */
export function PanelRightIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>;
}

/** Circular arrow — refresh. */
export function RefreshIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5" /><path d="M20 4v4.5h-4.5" /></svg>;
}
