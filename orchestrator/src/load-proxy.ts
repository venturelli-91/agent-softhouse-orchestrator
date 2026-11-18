import { createServer as httpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";

export type DelayProxy = { port: number; delay_ms: number; connections: number; close(): Promise<void> };

// Both listeners bind 127.0.0.1 only. With a target the bytes toward it are held back by delay_ms (order kept); without one it is an HTTP stub that answers 200 after the delay.
export async function startDelayProxy(target?: string): Promise<DelayProxy> {
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const p: DelayProxy = { port: 0, delay_ms: 0, connections: 0, close: async () => {} };
  const after = (ms: number, fn: () => void) => {
    const t = setTimeout(() => (timers.delete(t), fn()), ms);
    timers.add(t);
  };
  const track = (s: Socket, peer?: Socket) => {
    sockets.add(s);
    s.on("error", () => s.destroy());
    s.on("close", () => (sockets.delete(s), peer?.destroy()));
  };
  let server: Server;
  if (target) {
    const [host, port] = target.split(":");
    server = createServer((client) => {
      p.connections++;
      const up = connect({ host, port: Number(port) });
      track(client, up);
      track(up, client);
      // One serial chain per connection: each chunk waits delay_ms then writes, honoring upstream backpressure.
      // A single chain cannot reorder bytes, and honoring the write return bounds the memory (no chunk pile-up).
      let chain: Promise<void> = Promise.resolve();
      const hold = () => new Promise<void>((r) => after(p.delay_ms, r));
      client.on("data", (c) => {
        chain = chain.then(hold).then(() => (up.write(c) ? Promise.resolve() : new Promise<void>((r) => up.once("drain", r))));
      });
      client.on("end", () => {
        chain = chain.then(hold).then(() => { up.end(); });
      });
      up.pipe(client);
    });
  } else {
    const http = httpServer((req, res) => {
      p.connections++;
      req.resume();
      after(p.delay_ms, () => res.end("ok"));
    });
    http.on("connection", (s) => track(s));
    server = http as unknown as Server;
  }
  await new Promise<void>((ok, fail) => (server.once("error", fail), server.listen(0, "127.0.0.1", ok)));
  p.port = (server.address() as { port: number }).port;
  p.close = () => {
    timers.forEach(clearTimeout);
    sockets.forEach((s) => s.destroy());
    return new Promise((ok) => server.close(() => ok()));
  };
  return p;
}
