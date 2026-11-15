// PreToolUse (Write|Edit|NotebookEdit): blocks writes to secrets, git internals and Claude hooks/settings in the interactive session.
// ponytail: mirrors SECRET in orchestrator/src/evidence.ts; .claude/ is copied to projects without orchestrator/, so it cannot import it.
// Shell writes are not covered here: Bash stays behind the permission prompt, as in orch the real barrier is the env and the worktree.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const SECRET = /(^|\/)\.env|(^|\/)(\.git-credentials|\.npmrc|id_rsa[^/]*)$|\.(pem|key)$|credential|secret/i;
const GIT_INTERNALS = /(^|\/)\.git(\/|$)|(^|\/)\.git(attributes|modules)$/i;
// Matched on the absolute path too: the user-level ~/.claude settings and hooks run for every session.
const SELF = /(^|\/)\.claude\/(settings[^/]*\.json|hooks(\/|$))/i;
// Device and verbatim prefixes and 8.3 short names (CLAUDE~1) name a file under a second spelling the patterns would miss.
const ODD = /^(\\\\|\/\/)[?.]\\?|(^|[\\/])[^\\/]*~\d/;

// realpath.native expands 8.3 names and fixes case on Windows; it follows symlinks through the nearest existing ancestor.
const real = (p) => (existsSync(p) ? realpathSync.native(p) : dirname(p) === p ? p : join(real(dirname(p)), basename(p)));
// Win32 ignores trailing dots and spaces and treats `name:stream` as `name`: compare the name the filesystem will use.
const canonical = (p) => p.replaceAll("\\", "/").split("/").map((part, i) => (i === 0 && /^[a-z]:$/i.test(part) ? part : part.replace(/:.*$/, "").replace(/[. ]+$/, ""))).join("/");

const block = (why) => {
  process.stderr.write(`Blocked by .claude/hooks/guard.mjs: ${why}. Ask the CEO to change it by hand.\n`);
  process.exit(2);
};

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (file) {
  if (ODD.test(file)) block(`${file} uses a device prefix or a short (8.3) name`);
  const root = real(resolve(process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd()));
  const abs = canonical(real(resolve(root, file)));
  const rel = canonical(relative(root, real(resolve(root, file))));
  if (SELF.test(abs)) block(`${abs} is a Claude hook or settings file`);
  if (SECRET.test(rel)) block(`${rel} is a secret path`);
  if (GIT_INTERNALS.test(rel)) block(`${rel} is git internals`);
}
