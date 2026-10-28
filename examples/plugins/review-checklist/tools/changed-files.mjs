// The files git reports as changed in the current directory (the session's
// workspace), as JSON. Bivy writes the tool's input on stdin; this tool takes
// none.
import { execFileSync } from "node:child_process";

const STATUS = { M: "modified", A: "added", D: "deleted", R: "renamed", "?": "new" };
const out = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
const files = out.split("\n").filter(Boolean).map((line) => {
  const code = line.slice(0, 2).trim()[0] ?? "M";
  return { path: line.slice(3).split(" -> ").pop(), status: STATUS[code] ?? "changed" };
});
console.log(JSON.stringify({ files }));
