import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = (home: string) => join(home, "tickets");

// Agent text printed to the CEO's terminal: no escape sequences.
export const stripControl = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

export function checkId(id: string): void {
  if (!/^[\w.-]+$/.test(id) || id === "." || id === "..") throw new Error(`invalid ticket id: ${id}`);
}

export function ticketFile(home: string, id: string): string {
  checkId(id);
  return join(dir(home), `${id}.json`);
}

export function ticketIds(home: string): string[] {
  try {
    return readdirSync(dir(home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The pid of a live `orch` command working on this ticket, or null (no lock, or the lock belongs to a dead process).
export function runningPid(home: string, id: string): number | null {
  checkId(id);
  try {
    const pid = Number(readFileSync(join(dir(home), `${id}.lock`), "utf8"));
    return alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function lockTicket(home: string, id: string, pid = process.pid): () => void {
  checkId(id);
  mkdirSync(dir(home), { recursive: true });
  const lock = join(dir(home), `${id}.lock`);
  try {
    writeFileSync(lock, String(pid), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = Number(readFileSync(lock, "utf8"));
    if (alive(owner)) throw new Error(`${id} is already running (pid ${owner})`);
    unlinkSync(lock);
    writeFileSync(lock, String(pid), { flag: "wx" });
  }
  return () => {
    try {
      unlinkSync(lock);
    } catch {}
  };
}
