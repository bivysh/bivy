// SPDX-License-Identifier: AGPL-3.0-only
/** Public association metadata, supplied by the deployment, never inferred
 * from a hostname. Empty configuration keeps Universal Links disabled. */
export function associatedApps(value = "") {
  if (!value.trim()) return undefined;
  const appIDs = [...new Set(value.split(",").map(id => id.trim()))];
  if (appIDs.length > 10 || appIDs.some(id => !/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id))) throw new Error("Invalid APPLE_ASSOCIATED_APP_IDS");
  return { applinks: { details: [{ appIDs, components: [{ "/": "/sessions/*", comment: "Session links; authentication links stay in the browser." }, { "/": "/runs/*" }] }] } };
}
