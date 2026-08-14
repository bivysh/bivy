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

export function MoreIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
}

export function PlusIcon({ size = 20, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="M12 5v14M5 12h14" /></svg>;
}

export function CheckIcon({ size = 18, ...props }: IconProps) {
  return <svg {...common} {...props} viewBox="0 0 24 24" width={size} height={size}><path d="m5 12 4 4L19 6" /></svg>;
}
