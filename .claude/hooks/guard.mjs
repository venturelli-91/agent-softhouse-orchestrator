// PreToolUse (Write|Edit|NotebookEdit): blocks writes to secrets, git internals and the hooks themselves in the interactive session.
// ponytail: mirrors SECRET in orchestrator/src/evidence.ts; .claude/ is copied to projects without orchestrator/, so it cannot import it.
// Shell writes are not covered here: Bash stays behind the permission prompt, as in orch the real barrier is the env and the worktree.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const SECRET = /(^|\/)\.env|(^|\/)(\.git-credentials|\.npmrc|id_rsa[^/]*)$|\.(pem|key)$|credential|secret/i;
const GIT_INTERNALS = /(^|\/)\.git(\/|$)|(^|\/)\.git(attributes|modules)$/i;
const SELF = /^\.claude\/(settings[^/]*\.json|hooks(\/|$))/i;

// Follows symlinks through the nearest existing ancestor, so a link inside the repo cannot point the write elsewhere.
const real = (p) => (existsSync(p) ? realpathSync(p) : dirname(p) === p ? p : join(real(dirname(p)), basename(p)));
// Win32 ignores trailing dots and spaces and treats `name:stream` as `name`: compare the name the filesystem will use.
const canonical = (rel) => rel.split("/").map((part) => part.replace(/:.*$/, "").replace(/[. ]+$/, "")).join("/");

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (file) {
  const root = real(resolve(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd()));
  const rel = canonical(relative(root, real(resolve(root, file))).replaceAll("\\", "/"));
  const hit = SECRET.test(rel) ? "a secret path" : GIT_INTERNALS.test(rel) ? "git internals" : SELF.test(rel) ? "a hook or settings file" : "";
  if (hit) {
    process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${rel} is ${hit}. Ask the CEO to change it by hand.\n`);
    process.exit(2);
  }
}
