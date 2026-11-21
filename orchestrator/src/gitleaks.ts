import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { checkConfig, guarded, log, sh } from "./graph-kit.ts";
import { NodeFailure } from "./run-agent.ts";
import { type T } from "./ticket.ts";
import { InfraError } from "./webcheck.ts";

// Findings are "file:line (rule)" only: the value itself never leaves the scanner.
export type ScanRunner = (worktree: string, base: string) => Promise<string[]>;

const Findings = z.array(z.object({ File: z.string(), StartLine: z.number(), RuleID: z.string() }));
const LEAKS = 99;

// cwd and ignore path are an empty dir of ours: no binary in the worktree can shadow gitleaks and a dev-written .gitleaksignore is not read from there.
export const realScan: ScanRunner = (worktree, base) => {
  const dir = mkdtempSync(join(tmpdir(), "gitleaks-"));
  const args = ["git", `--log-opts=${base}..HEAD`, "--redact", "--no-banner", "--ignore-gitleaks-allow", "--report-format", "json", "--report-path", "-",
    "--exit-code", String(LEAKS), "--gitleaks-ignore-path", dir, worktree];
  return new Promise<string[]>((done, fail) =>
    execFile("gitleaks", args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout: 600_000, windowsHide: true }, (e, out) => {
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

function suppressions(t: T): string[] {
  const git = (...a: string[]) => sh(t.worktree, "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", ...a, t.base, "HEAD");
  const out = git("--name-only", "-z").split("\0").filter((f) => SUPPRESSOR.test(f)).map((f) => `${f} (gitleaks config or ignore file changed)`);
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
    found.push(...(await run(t.worktree, t.base)));
  } catch (e) {
    if (!(e instanceof InfraError)) throw e instanceof NodeFailure ? e : new NodeFailure((e as Error).message.split("\n")[0]);
    docs_warnings.push(`secrets skipped: ${e.message}`);
  }
  if (!found.length) return { status: "review", docs_warnings, history: log(t, "secrets", docs_warnings.length > t.docs_warnings.length ? "skipped: gitleaks not found" : "passed") };
  const comments = `possible secret or scanner suppression in the ticket's commits (value not shown; rewrite the commits so none of them holds it):\n${found.slice(0, 10).join("\n")}`;
  return { status: "dev_failed", revisions: t.revisions + 1, docs_warnings, summary: comments, rejections: [...t.rejections, `secrets: ${comments}`], history: log(t, "secrets", "rejected") };
});
