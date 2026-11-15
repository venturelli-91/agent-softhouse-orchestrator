// Tiny fixture service for the load stage tests. argv: port mode infoFile. Modes: lock (one global lock serializes every request and
// writes hold it across the dependency call), free (the dependency call is made outside any lock), die (exits after 1.5s), hang (never listens).
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
  const callDep = () => fetch(dep).then((r) => r.text());
  createServer(async (req, res) => {
    req.resume();
    try {
      if (mode === "lock") await exclusive(() => (req.method === "POST" ? callDep() : undefined));
      else if (req.method === "POST") (await callDep(), await exclusive(() => undefined));
      res.end("ok");
    } catch {
      res.statusCode = 500;
      res.end("err");
    }
  }).listen(Number(port), "127.0.0.1");
  if (mode === "die") setTimeout(() => process.exit(1), 1500);
}
