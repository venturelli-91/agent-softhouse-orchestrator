import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { minimalEnv, readEnv, permissionArgs, NODE_TIMEOUT_MS, type Role } from "./guardrails.ts";

export type Usage = {
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_create: number;
  cost_usd: number;
  turns: number;
  ms: number;
};

// The node builds the minimal context from the state; the executor only knows role + text.
export type Req<T> = {
  role: Role;
  files: string[]; // names in AGENTS_DIR, without .md
  context: string;
  schema: z.ZodType<T>;
  cwd: string;
};
export type Result<T> = { output: T; usage: Usage };
export interface Executor {
  run<T>(req: Req<T>): Promise<Result<T>>;
}

export class NodeFailure extends Error {}

export function loadPrompt(files: string[], dir = process.env.AGENTS_DIR): string {
  if (!dir) throw new NodeFailure("missing env: AGENTS_DIR");
  return files
    .map((a) => readFileSync(join(dir, `${a}.md`), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim())
    .join("\n\n---\n\n");
}

// The CLI does not know the draft 2020-12 that zod declares in $schema.
const jsonSchema = (s: z.ZodType) => ({ ...z.toJSONSchema(s), $schema: undefined });

// --max-turns counts the StructuredOutput turn of --json-schema, hence the +1.
// No --bare (it ignores the subscription login); the context is trimmed by the other flags.
export function claudeArgs(req: Pick<Req<unknown>, "role" | "schema">, system: string, env = process.env): string[] {
  return [
    "-p",
    "--model", readEnv("MODEL", req.role, env),
    "--effort", readEnv("EFFORT", req.role, env),
    "--max-turns", String(Number(readEnv("TURNS", req.role, env)) + 1),
    "--system-prompt", system,
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchema(req.schema as z.ZodType)),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...permissionArgs(req.role),
  ];
}

const claudeSubscription: Executor = {
  async run<T>(req: Req<T>): Promise<Result<T>> {
    const args = claudeArgs(req, loadPrompt(req.files));
    const t0 = Date.now();
    const raw = await new Promise<string>((ok, fail) => {
      const p = spawn("claude", args, { cwd: req.cwd, env: minimalEnv(req.role), signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => fail(new NodeFailure(`${req.role}: ${e.name === "AbortError" ? "timeout" : e.message}`)));
      p.on("close", (code) => (out ? ok(out) : fail(new NodeFailure(`${req.role}: exit ${code}: ${err.slice(0, 300)}`))));
      p.stdin.end(req.context);
    });

    return parseOutput(req.role, raw, req.schema, Date.now() - t0);
  },
};

// Output of `claude -p --output-format json` -> validated result. Any deviation is a failure.
export function parseOutput<T>(role: Role, raw: string, schema: z.ZodType<T>, ms: number): Result<T> {
  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    throw new NodeFailure(`${role}: output is not JSON`);
  }
  if (r.is_error || r.subtype !== "success") throw new NodeFailure(`${role}: ${r.subtype ?? "error"} (${r.terminal_reason})`);
  const output = schema.safeParse(r.structured_output);
  if (!output.success) throw new NodeFailure(`${role}: invalid output: ${output.error.message.slice(0, 300)}`);
  const u = r.usage;
  return {
    output: output.data,
    usage: {
      tokens_in: u.input_tokens,
      tokens_out: u.output_tokens,
      cache_read: u.cache_read_input_tokens,
      cache_create: u.cache_creation_input_tokens,
      cost_usd: r.total_cost_usd,
      turns: r.num_turns,
      ms,
    },
  };
}

const executors: Record<string, Executor> = { "claude-subscription": claudeSubscription };
// Hook for other executors (and for fake nodes in tests).
export const registerExecutor = (name: string, ex: Executor) => void (executors[name] = ex);

export function runAgent<T>(req: Req<T>): Promise<Result<T>> {
  const name = process.env.EXECUTOR ?? "claude-subscription";
  const ex = executors[name];
  if (!ex) throw new NodeFailure(`unknown EXECUTOR: ${name}`);
  return ex.run(req);
}
