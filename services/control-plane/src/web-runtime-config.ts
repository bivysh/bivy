// SPDX-License-Identifier: MIT
/** Public, allowlisted UI configuration. Never serialize process.env itself. */
export function webRuntimeConfigScript(env: NodeJS.ProcessEnv = process.env): string {
  const config = {
    ephemeralMachinesEnabled: env.EPHEMERAL_MACHINES_ENABLED === "1",
  };
  return `globalThis.__BIVY_RUNTIME_CONFIG__ = ${JSON.stringify(config)};\n`;
}
