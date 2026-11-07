// The dev specialties a ticket can be routed to, and the agent prompt each one runs.
export const SPECIALTIES = ["frontend", "backend", "fullstack", "mobile", "integrations", "ai", "data"] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export const DEV_FILE: Record<Specialty, string> = {
  frontend: "dev-frontend",
  backend: "dev-backend",
  fullstack: "dev-fullstack",
  mobile: "dev-mobile",
  integrations: "dev-integrations",
  ai: "ai-engineer",
  data: "data-engineer",
};

// Ready-made teams for `orch init --team <name>`; a repo can list any subset by hand in .orchestrator.json.
export const TEAMS: Record<string, Specialty[]> = {
  all: [...SPECIALTIES],
  web: ["frontend", "fullstack"],
  api: ["backend", "integrations", "data", "fullstack"],
  mobile: ["mobile", "backend", "fullstack"],
  ai: ["ai", "data", "backend", "fullstack"],
};
