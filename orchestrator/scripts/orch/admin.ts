// Commands that set up and tidy the orchestrator itself: init, status, clean.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { applyTeam, configJson, proposeTeam } from "../../src/team.ts";
import { usedToday } from "../../src/daily-cap.ts";
import { forgetDeploy } from "../../src/deploy.ts";
import { ensureLocalOnly } from "../../src/docs.ts";
import { deleteRemoteBranch } from "../../src/git-remote.ts";
import { report } from "../../src/graph.ts";
import { assertGitConfigUnchanged, repoOf, safeGit } from "../../src/guardrails.ts";
import { listIncidents } from "../../src/incidents.ts";
import { recordMetrics } from "../../src/metrics.ts";
import { bareNodeTest } from "../../src/repo-config.ts";
import { TEAMS } from "../../src/specialties.ts";
import { runningPid, ticketFile, ticketIds } from "../../src/ticket-store.ts";
import { type Ctx, die } from "./ctx.ts";

const DONE = ["simulated_deploy", "deployed", "aborted", "closed"];

export function init(c: Ctx) {
  const repo = resolve(c.positionals[0] ?? c.host);
  const file = join(repo, ".orchestrator.json");
  const team = c.values.team;
  if (team && !Object.hasOwn(TEAMS, team)) die(`unknown team ${team}: ${Object.keys(TEAMS).join(", ")}`);
  if (existsSync(file)) console.log(`${file} already exists${team ? `: set "specialties" there by hand (${TEAMS[team].join(", ")})` : ""}`);
  else {
    const specialties = team && team !== "all" ? { specialties: TEAMS[team] } : {};
    writeFileSync(file, configJson({ test: "npm test", merge: "pr", ...specialties }));
    console.log(`wrote ${file}: set "test" to the repo's test command, then commit it (it is read from the base commit)`);
    if (bareNodeTest(repo)) {
      console.warn(
        'warning: package.json "test" is a bare `node --test`: it will also run orchestrator/tests in every ticket worktree. '
        + 'Point "test" at an npm script that scopes it.',
      );
    }
  }
  if (!existsSync(join(repo, ".claude", "CLAUDE.md")) && !existsSync(join(repo, "CLAUDE.md"))) {
    console.log("no .claude/CLAUDE.md: the dev will have no repo conventions (commit format, style)");
  }
  console.log(ensureLocalOnly(repo) ?? `${join(repo, ".claude", "docs")} ready and ignored by git: the graph writes the project docs there`);
}

// Copies this folder into another repo and prepares it. Never overwrites: an existing orchestrator/ there stops the command.
const NOT_COPIED = new Set(["node_modules", ".env", ".state", ".git", ".github"]);
// Fixed arguments only; on Windows npm and npx are .cmd shims, which need a shell and a single command line.
const run = (bin: string, args: string[], cwd: string) =>
  process.platform === "win32" ? execFileSync(`${bin} ${args.join(" ")}`, { cwd, stdio: "inherit", shell: true }) : execFileSync(bin, args, { cwd, stdio: "inherit" });

// The host's linter and typechecker would otherwise scan orchestrator/ (own style, stricter @types/node) and break the host's `verify`. Printed, never applied.
const HOST_EXCLUDES = `add these by hand if the repo uses Biome or tsc, or its verify will fail on orchestrator/:
  biome.json     "files": { "includes": [..., "!orchestrator", "!.vscode"] }
  tsconfig.json  "exclude": [..., "orchestrator"]`;

export async function setup(c: Ctx) {
  const target = resolve(c.positionals[0] ?? die("usage: orch setup <repo> [--team <name>] [--no-install] [--yes]"));
  if (!existsSync(join(target, ".git"))) die(`${target} is not the root of a git repo`);
  const dest = join(target, "orchestrator");
  if (existsSync(dest)) die(`${dest} already exists: nothing copied`);
  cpSync(resolve(import.meta.dirname, "../.."), dest, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) });
  copyFileSync(join(dest, ".env.example"), join(dest, ".env"));
  console.log(`copied to ${dest} (.env created from .env.example: set PUBLISHER and the models there)`);
  if (!c.values["no-install"]) {
    run("npm", ["ci"], dest);
    // The browser is a ~150 MB download used only by the webcheck node: ask, and skip when there is nobody to ask.
    const browser = c.values.yes || (stdin.isTTY && (await createInterface({ input: stdin, output: stdout }).question("download Chromium for the webcheck node? [y/N] ")).trim().toLowerCase() === "y");
    if (browser) run("npx", ["playwright", "install", "chromium"], dest);
    else console.log("Chromium skipped: run `npx playwright install chromium` in orchestrator/ before using webcheck");
  }
  init({ ...c, positionals: [target] });
  console.log(HOST_EXCLUDES);
  console.log(`next: commit orchestrator/ and .orchestrator.json in ${target}; webcheck, if wanted, is configured by hand in ORCH_HOME/config.json`);
}

export async function team(c: Ctx) {
  const need = c.positionals[0] ?? die('usage: orch team "<need>" [--repo <path>] [--yes]');
  c.needCap();
  const repo = resolve(c.values.repo ?? c.host);
  const p = await proposeTeam(repo, need);
  console.log(`team: ${p.specialties.join(", ")}\nstack (${p.existing_stack ? "existing" : "recommended"}): ${p.stack}\ntest: ${p.test}\nwhy: ${p.rationale}`);
  for (const a of p.proposed_agents) console.log(`proposed agent (needs your approval, not created): ${a.name}: ${a.responsibility} (${a.why})`);
  const ok = c.values.yes || (await createInterface({ input: stdin, output: stdout }).question("write this to .orchestrator.json? [y/N] ")).trim().toLowerCase() === "y";
  if (!ok) return console.log("nothing written");
  console.log(`wrote ${applyTeam(repo, p)}: commit it (it is read from the base commit)`);
}

export async function status(c: Ctx) {
  const ids = c.positionals[0] ? [c.positionals[0]] : ticketIds(c.home);
  for (const id of ids) {
    const { ticket: t, pending } = await c.load(id);
    // Not finished, not waiting for an answer, and no live process: the run died (closed session, crash).
    const dead = !pending && !DONE.includes(t.status) && runningPid(c.home, id) === null;
    const waiting = pending ? `  <- waiting (${pending.type})` : dead ? `  <- no process running: orch continue ${id}` : "";
    console.log(`${id.padEnd(12)} ${t.status.padEnd(16)} ${t.priority.padEnd(4)} ${t.title}${waiting}${t.docs_warnings.length ? "  docs!" : ""}`);
    if (c.positionals[0]) {
      console.log(report(t));
      if (pending) console.log(JSON.stringify(pending, null, 1));
    }
  }
  if (!ids.length) console.log("no tickets");
  if (!c.positionals[0]) {
    for (const i of listIncidents(c.home)) {
      console.log(`${i.id.padEnd(16)} ${i.status.padEnd(8)} ${i.ticket} hotfix=${i.hotfix || "-"} rollback=${i.rollback}  ${i.symptom}`);
    }
  }
  if (process.env.TOKEN_CAP_DAILY) console.log(`tokens in the last 24h: ${usedToday()} / ${process.env.TOKEN_CAP_DAILY}`);
}

export async function clean(c: Ctx) {
  const ids = c.values.all ? ticketIds(c.home) : c.positionals[0] ? [c.positionals[0]] : die("usage: orch clean <id> | --all [--force] [--remote]");
  for (const id of ids) {
    await c.locked(id, async () => {
      const { ticket: t } = await c.load(id);
      if (!DONE.includes(t.status) && !c.values.force) {
        if (!c.values.all) die(`${id} is ${t.status}, not finished (use --force to discard it)`);
        return;
      }
      if (existsSync(t.worktree)) {
        const repo = t.repo || repoOf(t.worktree);
        if (c.values.remote) {
          assertGitConfigUnchanged(repo, t.git_config_hash);
          console.log(`${id}: remote branch ${deleteRemoteBranch(repo, t.push_remote, id)}`);
        }
        safeGit(repo, "worktree", "remove", "--force", t.worktree);
        safeGit(repo, "branch", "-D", `ticket/${id}`);
      }
      recordMetrics(c.home, t);
      unlinkSync(ticketFile(c.home, id));
      forgetDeploy(c.home, id);
      console.log(`cleaned ${id} (${t.status})`);
    });
  }
}
