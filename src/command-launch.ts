// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad

/** The executable/arguments chosen for a short-lived server command. */
export interface CommandLaunch {
  command: string;
  args: string[];
  usesPty: boolean;
}

/**
 * Keep terminal semantics opt-in for short-lived commands. Native interactive
 * commands must set requiresTty; ordinary commands stay on direct pipes and do
 * not pay for a Python PTY relay.
 */
export function commandLaunch(
  command: string,
  args: string[],
  requiresTty: boolean | undefined,
  pythonCommand: string,
  ptyRunnerScript: string,
): CommandLaunch {
  return requiresTty
    ? { command: pythonCommand, args: [ptyRunnerScript, command, ...args], usesPty: true }
    : { command, args: [...args], usesPty: false };
}
