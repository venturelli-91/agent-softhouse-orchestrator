import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { lockTicket } from "./ticket-store.ts";

export const MAX_LINES = 150;
export const MAX_FILES = 40;
export const MAX_BYTES = 200_000;
export const MAX_DEPTH = 3;
export const TOPICS = ["arquitetura", "backlog", "checklist", "design-patterns", "features", "testes", "trade-offs", "comunicacao", "aprendizados"] as const;

export const DocsOutput = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).max(MAX_FILES),
  not_applicable: z.array(z.object({ topic: z.string(), reason: z.string().min(5) })).default([]),
  notes: z.string().default(""),
});
export type DocsOutput = z.infer<typeof DocsOutput>;

export const docsDir = (repo: string) => join(repo, ".claude", "docs");
const NA_FILE = ".nao-se-aplica.json";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const lineCount = (s: string) => s.replace(/\r?\n$/, "").split(/\r?\n/).length;

function listMd(dir: string, rel = ""): string[] {
  let entries;
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listMd(dir, p) : e.name.endsWith(".md") && p !== "README.md" ? [p] : [];
  }).sort();
}

const readNa = (repo: string): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(join(docsDir(repo), NA_FILE), "utf8"));
  } catch {
    return {};
  }
};

// Why a path from the agent cannot be written, or null.
function badPath(repo: string, p: string): string | null {
  const parts = p.split("/");
  if (p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || parts.some((s) => s === "" || s === "." || s === "..")) return "unsafe path";
  if (!p.endsWith(".md")) return "only .md files";
  if (parts.length < 2 || parts.length > MAX_DEPTH) return `must be inside a topic directory, at most ${MAX_DEPTH} levels`;
  let cur = join(repo, ".claude");
  for (const part of [".", "docs", ...parts.slice(0, -1)]) {
    cur = part === "." ? cur : join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return "symlink in path";
    } catch {}
  }
  return null;
}

export function snapshot(repo: string, cap = 60_000): { index: string; seen: Record<string, string>; shown: Record<string, string> } {
  const dir = docsDir(repo);
  const seen: Record<string, string> = {};
  const shown: Record<string, string> = {};
  let used = 0;
  const index = listMd(dir).map((p) => {
    const text = readFileSync(join(dir, p), "utf8");
    if (used + text.length <= cap) {
      used += text.length;
      shown[p] = text;
      seen[p] = sha(text);
    }
    const title = text.split(/\r?\n/).find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? "";
    return `${p} | ${title} | ${lineCount(text)} lines`;
  }).join("\n");
  return { index, seen, shown };
}

export function coverage(repo: string): string[] {
  const na = readNa(repo);
  const have = listMd(docsDir(repo));
  return TOPICS.filter((t) => !na[t] && !have.some((p) => p.startsWith(`${t}/`))).map((t) => `topic "${t}" has no docs and no not-applicable note`);
}

function writeIndex(repo: string): void {
  const dir = docsDir(repo);
  const counts = new Map<string, number>();
  for (const p of listMd(dir)) counts.set(p.split("/")[0], (counts.get(p.split("/")[0]) ?? 0) + 1);
  const na = Object.entries(readNa(repo));
  const body = [
    "# Project docs", "", "Written by the orchestrator. Local only: never committed.", "", "## Topics",
    ...[...counts].sort().map(([d, n]) => `- \`${d}/\`: ${n} file${n === 1 ? "" : "s"}`),
    ...(na.length ? ["", "## Not applicable", ...na.map(([t, r]) => `- ${t}: ${r}`)] : []),
  ];
  writeFileSync(join(dir, "README.md"), `${body.slice(0, MAX_LINES - 1).join("\n")}\n`);
}

function put(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function writeDocs(repo: string, out: DocsOutput, seen: Record<string, string>, lockDir: string): { written: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const written: string[] = [];
  if (out.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > MAX_BYTES) return { written, warnings: [`docs output over ${MAX_BYTES} bytes: nothing written`] };
  let unlock: () => void;
  try {
    unlock = lockTicket(lockDir, "docs");
  } catch {
    return { written, warnings: ["docs are being written by another ticket: skipped"] };
  }
  try {
    const dir = docsDir(repo);
    mkdirSync(dir, { recursive: true });
    for (const f of out.files) {
      const bad = badPath(repo, f.path);
      if (bad) { warnings.push(`${f.path}: ${bad}`); continue; }
      if (lineCount(f.content) > MAX_LINES) { warnings.push(`${f.path}: over ${MAX_LINES} lines, kept the previous version`); continue; }
      const file = join(dir, f.path);
      if (existsSync(file) && seen[f.path] !== sha(readFileSync(file, "utf8"))) { warnings.push(`${f.path}: changed since the agent saw it, skipped`); continue; }
      put(file, f.content);
      written.push(f.path);
    }
    const na = { ...readNa(repo), ...Object.fromEntries(out.not_applicable.map((n) => [n.topic, n.reason])) };
    put(join(dir, NA_FILE), JSON.stringify(na, null, 1));
    writeIndex(repo);
  } finally {
    unlock();
  }
  return { written, warnings };
}
