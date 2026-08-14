// SPDX-License-Identifier: AGPL-3.0-only

export interface ReviewPromptFile {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
}

export interface ReviewPromptCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
}

function describe(file: ReviewPromptFile): string {
  const stats = [file.added ? `+${file.added}` : "", file.removed ? `−${file.removed}` : ""].filter(Boolean).join("/");
  return `\`${file.path}\` (${file.status}${stats ? `, ${stats}` : ""})`;
}

export function buildFileReviewPrompt(file: ReviewPromptFile): string {
  return `Review the change to ${describe(file)}. Explain why it changed, identify correctness or security risks, and suggest missing tests or follow-up edits.`;
}

export function buildChangeSetReviewPrompt(files: ReviewPromptFile[], checks: ReviewPromptCheck[] = []): string {
  const shown = files.slice(0, 30);
  const remaining = files.length - shown.length;
  const lines = shown.map((file) => `- ${describe(file)}`);
  if (remaining > 0) lines.push(`- …and ${remaining} more changed file${remaining === 1 ? "" : "s"}`);
  const failed = checks.filter((check) => check.status === "failed").map((check) => check.name);
  const checkNote = failed.length ? `\n\nFailed checks to investigate: ${failed.join(", ")}.` : "";
  return `Review this turn's code changes:\n${lines.join("\n")}${checkNote}\n\nFocus on correctness, regressions, security, and missing tests. Recommend concrete fixes where needed.`;
}
