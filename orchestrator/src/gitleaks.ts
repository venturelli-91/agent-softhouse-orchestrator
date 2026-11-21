import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkConfig, guarded, log, sh } from "./graph-kit.ts";
import { NodeFailure } from "./run-agent.ts";
import { type T } from "./ticket.ts";
import { InfraError } from "./webcheck.ts";

// Findings are "file:line (rule)" only: the value itself never leaves the scanner.
export type ScanRunner = (worktree: string, base: string, config: string) => Promise<string[]>;

const Findings = z.array(z.object({ File: z.string(), StartLine: z.number(), RuleID: z.string() }));
const LEAKS = 99;

// cwd, ignore path and config live in a dir of ours: no binary in the worktree can shadow gitleaks, and neither a worktree .gitleaks.toml
// (even untracked) nor the GITLEAKS_CONFIG* env vars can replace the base commit's config.
export const realScan: ScanRunner = (worktree, base, config) => {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-"));
  writeFileSync(join(dir, "gitleaks.toml"), config);
  const args = ["git", `--log-opts=--text --no-textconv --no-ext-diff -m ${base}..HEAD`, "--redact", "--no-banner", "--ignore-gitleaks-allow", "--report-format", "json", "--report-path", "-",
    "--exit-code", String(LEAKS), "--gitleaks-ignore-path", dir, "--config", join(dir, "gitleaks.toml"), worktree];
  const { GITLEAKS_CONFIG: _c, GITLEAKS_CONFIG_TOML: _t, ...env } = process.env;
  return new Promise<string[]>((done, fail) =>
    execFile("gitleaks", args, { cwd: dir, env, maxBuffer: 64 * 1024 * 1024, timeout: 600_000, windowsHide: true }, (e, out) => {
      const code = e ? (e as { code?: unknown }).code : 0;
      if (code === "ENOENT") return fail(new InfraError("gitleaks not found"));
      if (code !== 0 && code !== LEAKS) return fail(new NodeFailure(`gitleaks failed (exit ${typeof code === "number" ? code : "none"})`));
      try {
        done(Findings.parse(JSON.parse(out)).map((f) => `${f.File}:${f.StartLine} (${f.RuleID})`));
      } catch {
        fail(new NodeFailure("gitleaks printed no valid JSON report"));
      }
    }),
  ).finally(() => rmSync(dir, { recursive: true, force: true }));
};

let run: ScanRunner = realScan;
export const setScanRunner = (r: ScanRunner) => void (run = r);

const SUPPRESSOR = /(^|\/)\.gitleaks(\.toml|ignore)$/i;
const atBase = (t: T, f: string) => (sh(t.worktree, "ls-tree", "--name-only", t.base, "--", f) ? sh(t.worktree, "cat-file", "blob", `${t.base}:${f}`) : null);

function suppressions(t: T): string[] {
  const git = (...a: string[]) => sh(t.worktree, "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", ...a, t.base, "HEAD");
  const out = git("--name-only", "-z").split("\0").filter((f) => SUPPRESSOR.test(f)).map((f) => `${f} (gitleaks config or ignore file changed)`);
  // gitleaks always reads the worktree's root .gitleaksignore, also an untracked or ignored one the diff never shows.
  const ignore = join(t.worktree, ".gitleaksignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8").replace(/\r\n/g, "\n").trimEnd() : null;
  if (current !== atBase(t, ".gitleaksignore") && !out.some((f) => f.startsWith(".gitleaksignore ")))
    out.push(".gitleaksignore (differs from the base commit outside the commits)");
  let file = "";
  let line = 0;
  let del = 0;
  let add = 0;
  for (const l of git("-U0", "--text", "--no-color", "--no-prefix").split("\n")) {
    if (del > 0 && l.startsWith("-")) del--;
    else if (add > 0 && l.startsWith("+")) {
      add--;
      if (l.includes("gitleaks:allow")) out.push(`${file}:${line} (gitleaks:allow added)`);
      line++;
    } else if ((del === 0 && add === 0) || l.startsWith("@@")) {
      const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (h) [del, line, add] = [h[1] === undefined ? 1 : Number(h[1]), Number(h[2]), h[3] === undefined ? 1 : Number(h[3])];
      else if (l.startsWith("+++ ")) file = l.slice(4).replace(/\t$/, "");
    }
  }
  return out;
}

// Not an agent: zero tokens. On by default; a host without gitleaks skips with a docs warning.
export const secrets = guarded("secrets", async (t: T) => {
  checkConfig(t);
  const found = suppressions(t);
  const docs_warnings = [...t.docs_warnings];
  try {
    found.push(...(await run(t.worktree, t.base, atBase(t, ".gitleaks.toml") ?? "[extend]\nuseDefault = true\n")));
  } catch (e) {
    if (!(e instanceof InfraError)) throw e instanceof NodeFailure ? e : new NodeFailure((e as Error).message.split("\n")[0]);
    docs_warnings.push(`secrets skipped: ${e.message}`);
  }
  if (!found.length) return { status: "review", docs_warnings, history: log(t, "secrets", docs_warnings.length > t.docs_warnings.length ? "skipped: gitleaks not found" : "passed") };
  const comments = `possible secret or scanner suppression in the ticket's commits (value not shown). Run \`git reset --soft ${t.base}\`, remove it from the files, then commit again:\n${found.slice(0, 10).join("\n")}`;
  return { status: "dev_failed", revisions: t.revisions + 1, docs_warnings, summary: comments, rejections: [...t.rejections, `secrets: ${comments}`], history: log(t, "secrets", "rejected") };
});
