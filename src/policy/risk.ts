// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
export type RiskCategory =
  | "filesystem"
  | "shell"
  | "git.write"
  | "network.write"
  | "secret.read"
  | "external.write"
  | "deploy"
  | "payment"
  | "unknown";

export function riskCategoryForTool(toolName: string): RiskCategory {
  const tool = toolName.toLowerCase();
  if (["write", "edit", "multi_edit", "patch"].includes(tool)) return "filesystem";
  if (["bash", "shell", "terminal"].includes(tool)) return "shell";
  if (tool.includes("git") || tool.includes("github")) return "git.write";
  if (tool.includes("secret") || tool.includes("credential") || tool.includes("token")) return "secret.read";
  if (tool.includes("stripe") || tool.includes("payment")) return "payment";
  if (tool.includes("deploy") || tool.includes("release")) return "deploy";
  if (tool.includes("http") || tool.includes("fetch") || tool.includes("curl")) return "network.write";
  return "unknown";
}
