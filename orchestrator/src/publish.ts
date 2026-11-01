import { execFileSync } from "node:child_process";
import { devNull, safeGit } from "./guardrails.ts";
import { NodeFailure } from "./run-agent.ts";

// `sha` is the commit the verification checked; the target ref is derived from the id, never from HEAD.
export type Pub = { cwd: string; id: string; sha: string; title: string; body: string };
// Returns the evidence (e.g. "pr:<url>"). Push and PR are done by the graph's code, never by the agent.
export interface Publisher {
  publish(p: Pub): string;
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

const publishers: Record<string, Publisher> = { github, none: { publish: () => "pr:none" } };
export const registerPublisher = (name: string, p: Publisher) => void (publishers[name] = p);

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
