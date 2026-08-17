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
