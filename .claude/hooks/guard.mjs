// PreToolUse (Write|Edit|NotebookEdit): blocks writes to secrets and git internals in the interactive session.
// ponytail: mirrors SECRET in orchestrator/src/evidence.ts; .claude/ is copied to projects without orchestrator/, so it cannot import it.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const SECRET = /(^|\/)\.env|(^|\/)(\.git-credentials|\.npmrc|id_rsa[^/]*)$|\.(pem|key)$|credential|secret/i;
const GIT_INTERNALS = /(^|\/)\.git(\/|$)|(^|\/)\.git(attributes|modules)$/i;

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (file) {
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const rel = relative(root, resolve(root, file)).replaceAll("\\", "/");
  const hit = SECRET.test(rel) ? "a secret path" : GIT_INTERNALS.test(rel) ? "git internals" : "";
  if (hit) {
    process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${rel} is ${hit}. Ask the CEO to change it by hand.\n`);
    process.exit(2);
  }
}
