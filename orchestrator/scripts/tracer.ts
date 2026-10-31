// Tracer bullet: ticket trivial num repo-fixture descartavel, com o modelo real e worktree isolado.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, criarWorktree, montarGrafo, relatorio, retomar } from "../src/graph.ts";

const raiz = mkdtempSync(join(tmpdir(), "orch-"));
const repo = join(raiz, "fixture");
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=f@x.local", ...a], { cwd, stdio: "pipe" });
mkdirSync(join(repo, "test"), { recursive: true });
writeFileSync(join(repo, "package.json"), '{"name":"fixture","type":"module","scripts":{"test":"node --test"}}\n');
writeFileSync(join(repo, "checkout.html"), "<button>Enviar</button>\n");
writeFileSync(join(repo, "test/checkout.test.js"),
  'import { test } from "node:test";\nimport assert from "node:assert";\nimport { readFileSync } from "node:fs";\n' +
  'test("botao do checkout", () => assert.match(readFileSync("checkout.html", "utf8"), />Enviar pedido</));\n');
git(repo, "init", "-q", "-b", "main");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "fixture");

const id = "T-001";
const wt = criarWorktree(repo, id, join(raiz, `wt-${id}`));
const grafo = montarGrafo();
const cfg = config(id);
const pedido = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Trocar o texto do botao 'Enviar' para 'Enviar pedido' na tela de checkout (checkout.html).";

let r = await grafo.invoke({ id, pedido, ...wt }, cfg);
const pausa = (x: unknown) => (x as { __interrupt__?: { value: unknown }[] }).__interrupt__;
if (pausa(r)) {
  console.log(JSON.stringify(pausa(r)![0].value, null, 1));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const resp = (await rl.question("CEO (aprovar / motivo da rejeicao): ")).trim();
  rl.close();
  r = await grafo.invoke(retomar(resp) as never, cfg);
}
console.log(relatorio(r));
if (r.status !== "deploy_simulado") console.log(`motivo (${r.status}): ${r.resumo}`);
if (process.argv.includes("--mermaid")) console.log((await grafo.getGraphAsync()).drawMermaid());
console.log(`worktree mantido em ${raiz} (remova com rm -rf)`);
if (process.argv.includes("--limpar")) rmSync(raiz, { recursive: true, force: true });
