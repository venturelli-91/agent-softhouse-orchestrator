// Triage guesses the risk flags from the request text; the diff is the evidence. A path that looks sensitive adds the
// matching reviewer even if triage did not flag it (it only ever adds a reviewer, never removes one).
const SECURITY = /(^|[/._-])(auth|oauth|login|session|password|passwd|secret|token|crypto|jwt|cors|csrf|permission|acl|rbac)([/._-]|$)|(^|\/)\.env/i;
const AI = /(^|[/._-])(prompt|prompts|llm|embedding|embeddings|rag|agents?)([/._-]|$)/i;

export const pathFlags = (paths: string[]) => ({
  security: paths.some((p) => SECURITY.test(p)),
  ai: paths.some((p) => AI.test(p)),
});
