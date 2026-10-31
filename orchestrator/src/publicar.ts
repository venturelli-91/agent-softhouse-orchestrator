import { execFileSync } from "node:child_process";
import { gitSeguro } from "./guardrails.ts";
import { FalhaDeNo } from "./run-agent.ts";

export type Pub = { cwd: string; titulo: string; corpo: string };
// Devolve a evidencia (ex.: "pr:<url>"). Push e PR sao feitos pelo codigo do grafo, nunca pelo agente.
export interface Publicador {
  publicar(p: Pub): string;
}

const gh = (cwd: string, ...args: string[]) => execFileSync("gh", args, { cwd, encoding: "utf8" }).trim();

// Branch ticket/<id> vai para origin e o PR e sempre rascunho: merge e do CEO.
const github: Publicador = {
  publicar({ cwd, titulo, corpo }) {
    const branch = gitSeguro(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    gitSeguro(cwd, "push", "--set-upstream", "origin", branch);
    let url: string;
    try {
      url = gh(cwd, "pr", "view", branch, "--json", "url", "-q", ".url");
    } catch {
      url = gh(cwd, "pr", "create", "--draft", "--head", branch, "--title", titulo, "--body", corpo);
    }
    return `pr:${url.split("\n").pop()}`;
  },
};

const publicadores: Record<string, Publicador> = { github, nenhum: { publicar: () => "pr:nenhum" } };
export const registrarPublicador = (nome: string, p: Publicador) => void (publicadores[nome] = p);

// PUBLICADOR ausente = falha (fechado): nada vai para o remoto por omissao.
export function publicar(p: Pub): string {
  const nome = process.env.PUBLICADOR;
  if (!nome) throw new FalhaDeNo("env ausente: PUBLICADOR");
  const pub = publicadores[nome];
  if (!pub) throw new FalhaDeNo(`PUBLICADOR desconhecido: ${nome}`);
  try {
    return pub.publicar(p);
  } catch (e) {
    throw new FalhaDeNo(`publicar: ${(e as Error).message.slice(0, 300)}`);
  }
}
