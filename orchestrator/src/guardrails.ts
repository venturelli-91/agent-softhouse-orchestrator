// Public surface of the guardrails; each rule lives in its own module.
export { ALLOWED_ENV, minimalEnv, readEnv, type Role, SHELL } from "./agent-env.ts";
export { installDeps, verifyEvidence } from "./evidence.ts";
export { budgetExceeded, MAX_ACTIVE_TICKETS, MAX_REVISIONS, NODE_TIMEOUT_MS, RECURSION_LIMIT, selfApproval, tokens } from "./flow-limits.ts";
export { activeTickets, assertGitConfigUnchanged, devNull, gitConfigHash, repoOf, safeGit, safeRemoteGit } from "./git-safe.ts";
export { MAX_FILE_LINES, MAX_LINE_COLS } from "./modularity.ts";
export { DEFAULT_TEST, PERMISSIONS, permissionArgs } from "./permissions.ts";
