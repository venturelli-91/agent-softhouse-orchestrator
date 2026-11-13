import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DocsOutput, MAX_BYTES } from "./docs.ts";
import { protectedPaths, secretPaths } from "./guardrails.ts";
import { log, sh, ticketData } from "./graph-kit.ts";
import { DIFF_LIMIT } from "./review-nodes.ts";
import { runAgent, type Usage } from "./run-agent.ts";
import { stripControl } from "./ticket-store.ts";
import type { T } from "./ticket.ts";

const SHOWN_CAP = 20_000;
const PREFIX = "pre: ";

const regular = (file: string) => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};

// Why the agent may not write `path` in the worktree, or null. Only paths the base commit's config lists are ever writable.
function refusal(t: T, path: string): string | null {
  if (!t.project_docs.includes(path)) return "not in project_docs";
  if (secretPaths([path]).length) return "secret path";
  if (protectedPaths([path]).length) return "protected path";
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = join(t.worktree, ...parts.slice(0, i));
    try {
      if (lstatSync(p).isSymbolicLink()) return "symlink in path";
    } catch {}
  }
  return existsSync(join(t.worktree, path)) && !regular(join(t.worktree, path)) ? "not a regular file" : null;
}

// Pre-review docs phase: the repo's own tracked docs (`project_docs`) are updated and committed on the ticket's branch, so review, QA and the
// pinned sha all cover them. Never blocks: a problem becomes a warning and leaves the tree as the dev left it.
export async function projectDocsNode(t: T): Promise<Partial<T>> {
  if (!t.project_docs.length) return {};
  const keep = t.docs_warnings.filter((w) => !w.startsWith(PREFIX));
  const done = (warnings: string[], result: string, usage?: Usage): Partial<T> => ({
    docs_warnings: [...keep, ...warnings.map((w) => PREFIX + stripControl(w))],
    history: log(t, "docs", `${PREFIX}${result}`, usage),
  });
  try {
    const current = t.project_docs.map((p) => {
      const file = join(t.worktree, p);
      const text = existsSync(file) && !refusal(t, p) ? readFileSync(file, "utf8") : null;
      return `### ${p}\n${text === null ? "(missing: you may create it)" : text.length > SHOWN_CAP ? "(too large to show: do not edit)" : text}`;
    });
    const { output, usage } = await runAgent({
      role: "docs",
      files: ["docs"],
      cwd: t.worktree,
      schema: DocsOutput,
      context: [
        "Phase: pre. The work passed the dev's checks and goes to review next. Update the project docs below so they match this delivery:" +
          " mark finished items, fix test counts and any fact the diff changed. Return only files that need a change, with their full new content," +
          " paths exactly as listed (relative to the repo root, not to docs).",
        `CEO request: ${t.request}`,
        ticketData(t),
        `Diff stat:\n${sh(t.worktree, "diff", "--stat", t.base, "HEAD")}`,
        `Project docs (you may edit only these):\n${current.join("\n")}`,
      ].join("\n\n"),
    });
    const warnings: string[] = [];
    const written: string[] = [];
    const bytes = output.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    if (bytes > MAX_BYTES) return done([`output over ${MAX_BYTES} bytes: nothing written`], "0 file(s)", usage);
    try {
      for (const f of output.files) {
        const why = refusal(t, f.path);
        if (why) warnings.push(`${f.path}: ${why}`);
        else if (!existsSync(join(t.worktree, f.path)) || readFileSync(join(t.worktree, f.path), "utf8") !== f.content) {
          mkdirSync(dirname(join(t.worktree, f.path)), { recursive: true });
          writeFileSync(join(t.worktree, f.path), f.content);
          written.push(f.path);
        }
      }
      if (written.length) {
        sh(t.worktree, "--literal-pathspecs", "add", "--", ...written);
        if (sh(t.worktree, "diff", "--cached", "--no-ext-diff", t.base).length > DIFF_LIMIT)
          throw new Error(`the docs push the diff over the review limit (${DIFF_LIMIT})`);
        sh(t.worktree, "-c", "user.name=docs", "-c", "user.email=docs@orchestrator.local", "commit", "-q", "-m", `docs: update ${written.join(", ")}`);
      }
    } catch (e) {
      sh(t.worktree, "reset", "-q", "--hard", "HEAD");
      sh(t.worktree, "--literal-pathspecs", "clean", "-fdq", "--", ...t.project_docs);
      throw e;
    }
    return done(warnings, `${written.length} file(s) committed`, usage);
  } catch (e) {
    return done([(e instanceof Error ? e.message : String(e)).slice(0, 200)], "failed");
  }
}
