// SPDX-License-Identifier: AGPL-3.0-only
/** Public deployment configuration. Defaults describe the ordinary OSS client;
 * no origin or platform implicitly selects authentication/commercial policy. */
export interface ClientConfiguration {
  version: 1;
  platform: "browser" | "native";
  controlPlaneOrigin: string | null;
  connectionMode: "auto" | "account";
  authenticationMethods: readonly ("password" | "github" | "email")[];
  accountExtension: "visible" | "hidden";
  signInDescription?: string;
  unavailableSignInMessage?: string;
  accountUnavailableMessage?: string;
  accountDeletionMessage?: string;
  accountMessageRules: readonly { terms: readonly string[]; replacement: string }[];
}
export function parseClientConfiguration(raw?: string): ClientConfiguration {
  const value: unknown = raw ? JSON.parse(raw) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Client configuration must be an object");
  const input = value as Record<string, unknown>;
  const fields = new Set(["version", "platform", "controlPlaneOrigin", "connectionMode", "authenticationMethods", "accountExtension", "signInDescription", "unavailableSignInMessage", "accountUnavailableMessage", "accountDeletionMessage", "accountMessageRules"]);
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error(`Unknown client configuration field: ${key}`);
  const choice = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const result = input[key] === undefined ? fallback : input[key];
    if (!allowed.includes(result as T)) throw new Error(`Invalid client configuration: ${key}`);
    return result as T;
  };
  const text = (key: string): string | undefined => {
    if (input[key] === undefined) return undefined;
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 2000) throw new Error(`Invalid client configuration: ${key}`);
    return input[key];
  };
  if (input.version !== undefined && input.version !== 1) throw new Error("Unsupported client configuration version");
  const platform = choice("platform", ["browser", "native"], "browser");
  let origin: string | null = null;
  if (input.controlPlaneOrigin !== undefined && input.controlPlaneOrigin !== null) {
    if (typeof input.controlPlaneOrigin !== "string" || !input.controlPlaneOrigin) throw new Error("Invalid control-plane origin");
    const url = new URL(input.controlPlaneOrigin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Control-plane origin must be an HTTPS origin");
    origin = url.origin;
  }
  if (platform === "native" && !origin) throw new Error("Native storage requires an explicit control-plane origin");
  const methods = input.authenticationMethods === undefined ? ["password", "github", "email"] : input.authenticationMethods;
  if (!Array.isArray(methods) || methods.some(method => !["password", "github", "email"].includes(method)) || new Set(methods).size !== methods.length) throw new Error("Invalid authentication methods");
  const rules = input.accountMessageRules === undefined ? [] : input.accountMessageRules;
  if (!Array.isArray(rules) || rules.length > 20) throw new Error("Invalid account message rules");
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || Object.keys(rule).some(key => !["terms", "replacement"].includes(key)) ||
        !Array.isArray(rule.terms) || !rule.terms.length || rule.terms.length > 30 || rule.terms.some((term: unknown) => typeof term !== "string" || !term.trim() || term.length > 100) ||
        typeof rule.replacement !== "string" || !rule.replacement.trim() || rule.replacement.length > 2000) throw new Error("Invalid account message rule");
  }
  return {
    version: 1, platform, controlPlaneOrigin: origin,
    connectionMode: choice("connectionMode", ["auto", "account"], "auto"),
    authenticationMethods: methods as ClientConfiguration["authenticationMethods"],
    accountExtension: choice("accountExtension", ["visible", "hidden"], "visible"),
    signInDescription: text("signInDescription"), unavailableSignInMessage: text("unavailableSignInMessage"),
    accountUnavailableMessage: text("accountUnavailableMessage"), accountDeletionMessage: text("accountDeletionMessage"), accountMessageRules: rules,
  };
}

// Fail closed for an old shell rather than silently falling back to browser
// storage when a previous native build setting is accidentally retained.
if (import.meta.env?.VITE_BIVY_PACKAGED_CP) throw new Error("Replace VITE_BIVY_PACKAGED_CP with explicit VITE_BIVY_CLIENT_CONFIG");
export const clientConfiguration = parseClientConfiguration(import.meta.env?.VITE_BIVY_CLIENT_CONFIG);
export const requiresAccountConnection = clientConfiguration.connectionMode === "account";

export function configuredAuthentication<T extends { enabled: boolean; github: boolean; email: boolean }>(methods: T, config = clientConfiguration): T {
  return {
    ...methods,
    enabled: methods.enabled && config.authenticationMethods.includes("password"),
    github: methods.github && config.authenticationMethods.includes("github"),
    email: methods.email && config.authenticationMethods.includes("email"),
  };
}
export function showAccountExtension(config = clientConfiguration): boolean {
  return config.accountExtension === "visible";
}
export function accountPresentationMessage(message: string, config = clientConfiguration): string {
  const rule = config.accountMessageRules.find(rule => rule.terms.some(term => message.toLowerCase().includes(term.toLowerCase())));
  return rule?.replacement ?? message;
}
export function accountUnavailableMessage(): string {
  return clientConfiguration.accountUnavailableMessage ?? "This operation is not available for this account.";
}
