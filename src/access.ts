// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
//
// How this machine can be reached, as one table: the setups (this machine only,
// Tailscale, Bivy hosted, your own server), what each gives you, and which are
// active here. `bivy access`, `bivy status`, setup and the app all render this
// report, so they always agree. Setups stack: each only adds to the ones before.

/** 0 = no, 1 = on your tailnet only, 2 = from anywhere. */
export type Reach = 0 | 1 | 2;

export const ACCESS_FEATURES = [
  { id: "devices", label: "Your phone and other devices" },
  { id: "machines", label: "All your machines in one app" },
  { id: "push", label: "Push notifications" },
  { id: "sharing", label: "App previews" },
] as const;
export type AccessFeatureId = (typeof ACCESS_FEATURES)[number]["id"];

export type AccessSetupId = "local" | "tailscale" | "hosted" | "server";

interface SetupRow {
  id: AccessSetupId;
  label: string;
  summary: string;
  /** What to run to add this setup, when there is one command for it. */
  command?: string;
  gives: Record<AccessFeatureId, Reach>;
}

export const ACCESS_SETUPS: readonly SetupRow[] = [
  { id: "local", label: "This machine only", summary: "The terminal and a browser on this machine.", gives: { devices: 0, machines: 0, push: 0, sharing: 0 } },
  { id: "tailscale", label: "Tailscale", summary: "Chat, approvals and terminals on your devices, over your tailnet. No account, nothing in between.", command: "bivy access tailscale", gives: { devices: 1, machines: 1, push: 0, sharing: 0 } },
  { id: "hosted", label: "Bivy hosted", summary: "Sign in once. Sessions stay end-to-end encrypted.", command: "bivy access hosted", gives: { devices: 2, machines: 2, push: 2, sharing: 2 } },
  { id: "server", label: "Your own server", summary: "Like hosted, on a server you control.", command: "bivy access server <url>", gives: { devices: 2, machines: 2, push: 2, sharing: 2 } },
];

export interface AccessInputs {
  /** The machine's tailnet name when `bivy tailscale` is on. */
  tailscaleHostname?: string | null;
  /** relay.json, when the node is linked to a relay. */
  relay?: { controlPlaneUrl?: string; room?: string; roomToken?: string } | null;
  /** The hosted control plane this build points at, to tell hosted from self-hosted. */
  hostedControlPlane: string;
}

export interface AccessReport {
  features: typeof ACCESS_FEATURES;
  setups: (SetupRow & { active: boolean })[];
  active: AccessSetupId[];
  /** What this machine can do now, per feature. */
  reach: Record<AccessFeatureId, Reach>;
  /** Setups that would add something, in ladder order, with what each adds. */
  next: { id: AccessSetupId; adds: AccessFeatureId[]; addsText: string }[];
  tailscaleUrl?: string;
  controlPlaneUrl?: string;
}

/** "a, b and c" (or "a and b"). */
function and(items: string[]): string {
  return items.length < 2 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const origin = (url: string | undefined) => {
  try { return url ? new URL(url).origin : ""; } catch { return ""; }
};

/** Which setups are active, from what the node has on disk. */
export function activeSetups(inputs: AccessInputs): AccessSetupId[] {
  const active: AccessSetupId[] = ["local"];
  if (inputs.tailscaleHostname) active.push("tailscale");
  const relay = inputs.relay;
  if (relay?.room && relay.roomToken) active.push("server");
  else if (relay?.controlPlaneUrl) active.push(origin(relay.controlPlaneUrl) === origin(inputs.hostedControlPlane) ? "hosted" : "server");
  return active;
}

export function accessReport(inputs: AccessInputs): AccessReport {
  const active = activeSetups(inputs);
  const reach = {} as Record<AccessFeatureId, Reach>;
  for (const { id } of ACCESS_FEATURES) {
    reach[id] = Math.max(...ACCESS_SETUPS.filter((s) => active.includes(s.id)).map((s) => s.gives[id])) as Reach;
  }
  // Hosted and your own server are alternatives: once one is on, neither is a next step.
  const linked = active.includes("hosted") || active.includes("server");
  const next = ACCESS_SETUPS
    .filter((s) => !active.includes(s.id) && !(linked && (s.id === "hosted" || s.id === "server")))
    .map((s) => {
      const adds = ACCESS_FEATURES.filter((f) => s.gives[f.id] > reach[f.id]);
      // What you already have on your tailnet only widens: say "from anywhere" once for those.
      const widened = adds.filter((f) => reach[f.id] === 1).map((f) => f.label.toLowerCase());
      const fresh = adds.filter((f) => reach[f.id] === 0).map((f) => f.label.toLowerCase());
      const phrases = [...(widened.length ? [`${and(widened)} from anywhere`] : []), ...fresh];
      return { id: s.id, adds: adds.map((f) => f.id), addsText: and(phrases) };
    })
    .filter((s) => s.adds.length > 0);
  return {
    features: ACCESS_FEATURES,
    setups: ACCESS_SETUPS.map((s) => ({ ...s, active: active.includes(s.id) })),
    active,
    reach,
    next,
    ...(inputs.tailscaleHostname ? { tailscaleUrl: `https://${inputs.tailscaleHostname}` } : {}),
    ...(inputs.relay?.controlPlaneUrl ? { controlPlaneUrl: inputs.relay.controlPlaneUrl } : {}),
  };
}
