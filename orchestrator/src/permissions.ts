// Defense inside each node: which tools each role gets, and what is allowed or denied.
import { type Role, SHELL } from "./agent-env.ts";

const sh = (...patterns: string[]) => patterns.map((p) => `${SHELL}(${p})`);

export const DEFAULT_TEST = "npm test";

const READ_ONLY = ["Read", "Grep", "Glob"];
const SECRETS = [
  "Read(**/.env*)", "Edit(**/.env*)", "Write(**/.env*)",
  "Read(~/.ssh/**)", "Read(~/.claude/**)", "Read(~/.npmrc)", "Read(~/.git-credentials)", "Read(**/.git/config)",
];
// Git hooks, filters and fsmonitor run code: the dev must not write to them.
const GIT_INTERNALS = [
  "Write(**/node_modules/**)", "Edit(**/node_modules/**)", "Write(**/.git/**)", "Edit(**/.git/**)", "Write(**/.git)", "Edit(**/.git)",
  "Write(**/.gitattributes)", "Edit(**/.gitattributes)", "Write(**/.gitmodules)", "Edit(**/.gitmodules)",
];

// tools = built-in tools available; allow = auto-approved; deny = always denied.
// Bash with an allowlist is inherently weak: the real barrier is a worktree without .env + an env without credentials.
export const PERMISSIONS: Record<Role, { tools: string[]; allow: string[]; deny: string[] }> = {
  triage: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  planner: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  reviewer: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  qa: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  devops: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  watchdog: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  knowledge: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  docs: { tools: READ_ONLY, allow: READ_ONLY, deny: SECRETS },
  dev: {
    tools: [...READ_ONLY, "Write", "Edit", SHELL],
    allow: [
      ...READ_ONLY, "Write(./**)", "Edit(./**)",
      ...sh("git add *", "git commit *", "git status*", "git diff*", "git log*", "npm test*", "npm run typecheck*"),
    ],
    deny: [
      ...SECRETS, ...GIT_INTERNALS,
      ...sh(
        "npm exec*", "npx*", "npm config*", "npm publish*", "npm pkg*", "git push*", "git log*--output*", "git diff*--output*",
        "git remote*", "git config*", "rm *", "Remove-Item*", "del *", "rmdir*",
      ),
    ],
  },
};

// `test` is the repo's own test command (from .orchestrator.json); the dev may run exactly that.
export function permissionArgs(role: Role, test = DEFAULT_TEST): string[] {
  const p = PERMISSIONS[role];
  const allow = role === "dev" ? [...p.allow.filter((a) => a !== `${SHELL}(${DEFAULT_TEST}*)`), `${SHELL}(${test}*)`] : p.allow;
  return [
    "--permission-mode", "dontAsk",
    "--tools", p.tools.join(","),
    "--allowedTools", ...allow,
    "--disallowedTools", ...p.deny,
  ];
}
