import { execFileSync } from "node:child_process";
import { devNull, safeGit } from "./guardrails.ts";
import { NodeFailure } from "./run-agent.ts";

// `sha` is the commit the verification checked; the target ref is derived from the id, never from HEAD.
export type Pub = { cwd: string; id: string; sha: string; title: string; body: string };
// Returns the evidence (e.g. "pr:<url>"). Push and PR are done by the graph's code, never by the agent.
export interface Publisher {
  publish(p: Pub): string;
  // Squash-merge a PR already approved by the CEO. Throws unless the CI is green and the PR is still at `sha`.
  merge?(m: { cwd: string; pr: string; sha: string }): Promise<string>;
}

const gh = (cwd: string, ...args: string[]) => execFileSync("gh", args, { cwd, encoding: "utf8" }).trim();

// The ticket/<id> branch goes to origin and the PR is always a draft: merging is up to the CEO.
const github: Publisher = {
  publish({ cwd, id, sha, title, body }) {
    const branch = `ticket/${id}`;
    safeGit(cwd, "-c", `core.hooksPath=${devNull}`, "push", "--no-verify", "origin", `${sha}:refs/heads/${branch}`);
    let url: string;
    try {
      url = gh(cwd, "pr", "view", branch, "--json", "url", "-q", ".url");
    } catch {
      url = gh(cwd, "pr", "create", "--draft", "--head", branch, "--title", title, "--body", body);
    }
    return `pr:${url.split("\n").pop()}`;
  },
};

type Check = { bucket: string };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// Waits for the CI (MERGE_WAIT_MS, default 10 min). No checks at all = no proof, so no automatic merge.
async function mergeGithub({ cwd, pr, sha }: { cwd: string; pr: string; sha: string }): Promise<string> {
  const head = gh(cwd, "pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid");
  if (head !== sha) throw new Error(`PR head ${head.slice(0, 7)} is not the verified commit ${sha.slice(0, 7)}`);
  const deadline = Date.now() + (Number(process.env.MERGE_WAIT_MS) || 600_000);
  for (;;) {
    let checks: Check[] = [];
    try {
      checks = JSON.parse(gh(cwd, "pr", "checks", pr, "--json", "bucket"));
    } catch {
      // gh exits non-zero when there are no checks yet
    }
    if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) throw new Error("CI checks failed");
    if (checks.length && checks.every((c) => c.bucket === "pass" || c.bucket === "skipping")) break;
    if (Date.now() > deadline) throw new Error(checks.length ? "CI checks still pending" : "no CI checks found, not merging automatically");
    await sleep(15_000);
  }
  gh(cwd, "pr", "ready", pr);
  gh(cwd, "pr", "merge", pr, "--squash", "--delete-branch", "--match-head-commit", sha);
  return `merged:${pr}`;
}
github.merge = mergeGithub;

const publishers: Record<string, Publisher> = { github, none: { publish: () => "pr:none" } };
export const registerPublisher = (name: string, p: Publisher) => void (publishers[name] = p);

export async function mergePr(m: { cwd: string; pr: string; sha: string }): Promise<string> {
  const pub = publishers[process.env.PUBLISHER ?? ""];
  if (!pub?.merge) throw new NodeFailure("merge: the configured PUBLISHER cannot merge");
  try {
    return await pub.merge(m);
  } catch (e) {
    throw new NodeFailure(`merge: ${(e as Error).message.slice(0, 300)}`);
  }
}

// Missing PUBLISHER = failure (closed): nothing goes to the remote by default.
export function publish(p: Pub): string {
  const name = process.env.PUBLISHER;
  if (!name) throw new NodeFailure("missing env: PUBLISHER");
  const pub = publishers[name];
  if (!pub) throw new NodeFailure(`unknown PUBLISHER: ${name}`);
  try {
    return pub.publish(p);
  } catch (e) {
    throw new NodeFailure(`publish: ${(e as Error).message.slice(0, 300)}`);
  }
}
