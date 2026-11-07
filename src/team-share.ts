// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Petter André Sjulstad
import type { LinkedDevice } from "./device-registry.js";

/**
 * Sharing this machine with the team (services/control-plane/src/team-machines.ts).
 *
 * The switch lives here, on the machine. While it is on, teammates' devices
 * may pair (src/remote/relay-client.ts refuses them otherwise) and use the
 * machine as fully as the owner: sessions, terminals and files. That is what
 * holding the room key means.
 *
 * Each check asks the control plane who is in the team now and removes any
 * teammate device that no longer belongs, rotating the room key as a manual
 * removal does. Turning sharing off removes every teammate device.
 *
 * The switch is for the team the owner was in when they turned it on. When the
 * owner leaves that team (or joins another), it turns itself off rather than
 * share the machine with people they never chose.
 */

export interface TeamShareDeps {
  /** Authenticated control-plane request; null when this machine isn't enrolled. */
  request(pathname: string, init?: RequestInit): Promise<Response | null>;
  enabled(): boolean;
  devices(): LinkedDevice[];
  /** Remove a device and rotate the room key for the rest. */
  revoke(deviceId: string): void;
  /** Turn the machine's own switch off (the team no longer allows sharing). */
  disable?(): void;
  /** The team the switch was turned on for, and recording it. */
  boundTeam?(): string | undefined;
  bind?(teamId: string): void;
}

/** What the control plane reports. `teamId` is the owner's team now; older
 *  control planes leave it out. */
interface RemoteShare { shared: boolean; memberAccountIds: string[]; teamId?: string | null }

/** The control plane refused because of a team policy. */
export class TeamPolicyError extends Error {}

/** Teammate devices that must go: all of them when sharing is off, else
 * those whose account has left the team. */
export function teammateDevicesToRemove(devices: LinkedDevice[], state: { shared: boolean; memberAccountIds: string[] }): LinkedDevice[] {
  const members = new Set(state.memberAccountIds);
  return devices.filter((d) => d.teammate && (!state.shared || !members.has(d.teammate.accountId)));
}

/** The teammate whose device has `publicKeyB64`, if it is one. Attribution
 * only: every device on the machine has the same access. */
export function teammateByDevice(devices: LinkedDevice[], publicKeyB64: unknown): LinkedDevice["teammate"] | undefined {
  return typeof publicKeyB64 === "string" && publicKeyB64 ? devices.find((d) => d.publicKeyB64 === publicKeyB64)?.teammate : undefined;
}

export class TeamShare {
  constructor(private readonly deps: TeamShareDeps) {}

  teammateDevices(): LinkedDevice[] {
    return this.deps.devices().filter((d) => d.teammate);
  }

  /** Tell the control plane this machine's switch, then reconcile devices.
   * Throws if the control plane refuses (e.g. the account isn't in a team). */
  async publish(): Promise<void> {
    const res = await this.deps.request("/node/team-share", { method: "PUT", body: JSON.stringify({ shared: this.deps.enabled() }) });
    if (res && !res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      const message = data.error || `Could not change sharing (${res.status})`;
      throw data.code === "team-policy" ? new TeamPolicyError(message) : new Error(message);
    }
    if (res?.ok) {
      const remote = (await res.json()) as RemoteShare;
      if (remote.shared && remote.teamId) this.deps.bind?.(remote.teamId);
      this.reconcile(remote);
    } else this.reconcile({ shared: this.deps.enabled(), memberAccountIds: [] });
  }

  /** Periodic check: the control plane may have dropped sharing (the owner
   * left the team) or a teammate may have left. */
  async check(): Promise<void> {
    const res = await this.deps.request("/node/team-share").catch(() => null);
    if (!res?.ok) {
      // Offline or not enrolled: only the local switch is known.
      if (!this.deps.enabled()) this.reconcile({ shared: false, memberAccountIds: [] });
      return;
    }
    const remote = (await res.json()) as RemoteShare;
    if (this.deps.enabled() && remote.teamId !== undefined) {
      const bound = this.deps.boundTeam?.();
      if (remote.teamId === null || (bound && bound !== remote.teamId)) {
        this.deps.disable?.();
        return this.reconcile({ shared: false, memberAccountIds: [] });
      }
      // Turned on before the switch remembered its team: this one.
      if (!bound) this.deps.bind?.(remote.teamId);
    }
    // The control plane forgets the flag when a machine re-enrolls; restate it.
    if (this.deps.enabled() && !remote.shared && remote.memberAccountIds.length) {
      try {
        return await this.publish();
      } catch (error) {
        // The team turned sharing off: so does this machine, and its teammates go.
        if (!(error instanceof TeamPolicyError)) throw error;
        this.deps.disable?.();
        return this.reconcile({ shared: false, memberAccountIds: remote.memberAccountIds });
      }
    }
    this.reconcile({ shared: this.deps.enabled() && remote.shared, memberAccountIds: remote.memberAccountIds });
  }

  private reconcile(state: { shared: boolean; memberAccountIds: string[] }): void {
    for (const device of teammateDevicesToRemove(this.deps.devices(), state)) this.deps.revoke(device.id);
  }
}
