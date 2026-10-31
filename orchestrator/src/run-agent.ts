import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { envMinimo, lerEnv, permissoesArgs, TIMEOUT_POR_NO_MS, type Papel } from "./guardrails.ts";

export type Consumo = {
  tokens_in: number;
  tokens_out: number;
  cache_read: number;
  cache_create: number;
  custo_usd: number;
  turnos: number;
  ms: number;
};

// O no monta o contexto minimo a partir do estado; o executor so conhece papel + texto.
export type Req<T> = {
  papel: Papel;
  arquivos: string[]; // nomes em AGENTS_DIR, sem .md
  contexto: string;
  schema: z.ZodType<T>;
  cwd: string;
};
export type Resultado<T> = { saida: T; consumo: Consumo };
export interface Executor {
  run<T>(req: Req<T>): Promise<Resultado<T>>;
}

export class FalhaDeNo extends Error {}

export function carregarPrompt(arquivos: string[], dir = process.env.AGENTS_DIR): string {
  if (!dir) throw new FalhaDeNo("env ausente: AGENTS_DIR");
  return arquivos
    .map((a) => readFileSync(join(dir, `${a}.md`), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim())
    .join("\n\n---\n\n");
}

// O CLI nao conhece o draft 2020-12 que o zod declara em $schema.
const jsonSchema = (s: z.ZodType) => ({ ...z.toJSONSchema(s), $schema: undefined });

// --max-turns conta o turno do StructuredOutput do --json-schema, dai o +1.
// Sem --bare (ele ignora o login da assinatura); o contexto e enxugado pelas demais flags.
export function argsClaude(req: Pick<Req<unknown>, "papel" | "schema">, sistema: string, env = process.env): string[] {
  return [
    "-p",
    "--model", lerEnv("MODEL", req.papel, env),
    "--effort", lerEnv("EFFORT", req.papel, env),
    "--max-turns", String(Number(lerEnv("TURNOS", req.papel, env)) + 1),
    "--system-prompt", sistema,
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchema(req.schema as z.ZodType)),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...permissoesArgs(req.papel),
  ];
}

const claudeSubscription: Executor = {
  async run<T>(req: Req<T>): Promise<Resultado<T>> {
    const args = argsClaude(req, carregarPrompt(req.arquivos));
    const t0 = Date.now();
    const bruto = await new Promise<string>((ok, erro) => {
      const p = spawn("claude", args, { cwd: req.cwd, env: envMinimo(req.papel), signal: AbortSignal.timeout(TIMEOUT_POR_NO_MS) });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => erro(new FalhaDeNo(`${req.papel}: ${e.name === "AbortError" ? "timeout" : e.message}`)));
      p.on("close", (code) => (out ? ok(out) : erro(new FalhaDeNo(`${req.papel}: exit ${code}: ${err.slice(0, 300)}`))));
      p.stdin.end(req.contexto);
    });

    const r = JSON.parse(bruto);
    if (r.is_error || r.subtype !== "success") throw new FalhaDeNo(`${req.papel}: ${r.subtype ?? "erro"} (${r.terminal_reason})`);
    const saida = req.schema.safeParse(r.structured_output);
    if (!saida.success) throw new FalhaDeNo(`${req.papel}: saida invalida: ${saida.error.message.slice(0, 300)}`);
    const u = r.usage;
    return {
      saida: saida.data,
      consumo: {
        tokens_in: u.input_tokens,
        tokens_out: u.output_tokens,
        cache_read: u.cache_read_input_tokens,
        cache_create: u.cache_creation_input_tokens,
        custo_usd: r.total_cost_usd,
        turnos: r.num_turns,
        ms: Date.now() - t0,
      },
    };
  },
};

const executores: Record<string, Executor> = { "claude-subscription": claudeSubscription };

export function runAgent<T>(req: Req<T>): Promise<Resultado<T>> {
  const nome = process.env.EXECUTOR ?? "claude-subscription";
  const ex = executores[nome];
  if (!ex) throw new FalhaDeNo(`EXECUTOR desconhecido: ${nome}`);
  return ex.run(req);
}
