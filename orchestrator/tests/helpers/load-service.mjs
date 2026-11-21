// Tiny fixture service for the load stage tests. argv: port mode infoFile. Modes: lock (one global lock serializes every request and
// writes hold it across the dependency call), free (the dependency call is made outside any lock), die (exits after 1.5s), hang (never listens),
// guarded (like free, but the dependency call times out after 1s and a failure answers 503), retry (like free, but a failed dependency call
// is retried forever, so writes hang while the dependency is down), sticky (like free, but after one failed dependency call every write
// answers 500 without calling it again: it never reconnects, while GETs keep answering).
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const [port, mode, info] = process.argv.slice(2);
const dep = process.env.DEP_URL;
writeFileSync(info, JSON.stringify({ pid: process.pid, dep }));

if (mode === "hang") setInterval(() => {}, 1000);
else {
  let tail = Promise.resolve();
  const exclusive = (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
  const once = () => fetch(dep, mode === "guarded" ? { signal: AbortSignal.timeout(1000) } : {}).then((r) => r.text());
  const callDep = async () => {
    for (;;) {
      try {
        return await once();
      } catch (e) {
        if (mode !== "retry") throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  let broken = false;
  createServer(async (req, res) => {
    req.resume();
    try {
      if (broken && req.method === "POST") throw new Error("never reconnects");
      if (mode === "lock") await exclusive(() => (req.method === "POST" ? callDep() : undefined));
      else if (req.method === "POST") (await callDep(), await exclusive(() => undefined));
      res.end("ok");
    } catch {
      broken = mode === "sticky";
      res.statusCode = mode === "guarded" ? 503 : 500;
      res.end("err");
    }
  }).listen(Number(port), "127.0.0.1");
  if (mode === "die") setTimeout(() => process.exit(1), 1500);
}
