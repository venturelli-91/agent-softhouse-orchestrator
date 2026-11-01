// Push a plain-text message to NOTIFY_URL (e.g. https://ntfy.sh/<secret-topic> reaches your phone). Unset = silent.
// A failed notification must never break a ticket, so it only warns.
// ponytail: plain-text POST; Slack/Discord need a JSON body, add a formatter if you use them.
export async function notify(text: string, env: NodeJS.ProcessEnv = process.env) {
  if (!env.NOTIFY_URL) return;
  try {
    const res = await fetch(env.NOTIFY_URL, { method: "POST", body: text, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.error(`notify: HTTP ${res.status}`);
  } catch (e) {
    console.error(`notify failed: ${(e as Error).message}`);
  }
}
