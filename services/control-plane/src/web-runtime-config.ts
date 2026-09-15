// SPDX-License-Identifier: AGPL-3.0-only
/** Public, allowlisted UI configuration. Never serialize process.env itself. */
export function webRuntimeConfigScript(env: NodeJS.ProcessEnv = process.env): string {
  const config = {
    ephemeralMachinesEnabled: env.VITE_EPHEMERAL_MACHINES_ENABLED === "1"
      && env.EPHEMERAL_MACHINES_ENABLED !== "0",
  };
  return `globalThis.__BIVY_RUNTIME_CONFIG__ = ${JSON.stringify(config)};\n`;
}
