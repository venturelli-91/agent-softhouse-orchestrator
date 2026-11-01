import { MemorySaver } from "@langchain/langgraph";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function encode(this: Record<string, unknown>, key: string, value: unknown) {
  const raw = this[key];
  return ArrayBuffer.isView(raw) ? { $u8: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") } : value;
}
const decode = (_: string, v: { $u8?: string }) => (v && typeof v === "object" && v.$u8 !== undefined ? new Uint8Array(Buffer.from(v.$u8, "base64")) : v);

// MemorySaver whose state survives the process, so the CEO can approve from a later run.
// ponytail: rewrites the whole file on every checkpoint; fine for a few local tickets, swap for SQLite if it grows.
export class FileSaver extends MemorySaver {
  private file: string;

  constructor(file: string) {
    super();
    this.file = file;
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8"), decode);
      this.storage = saved.storage;
      this.writes = saved.writes;
    }
  }

  private save() {
    writeFileSync(this.file, JSON.stringify({ storage: this.storage, writes: this.writes }, encode));
  }

  override async put(...args: Parameters<MemorySaver["put"]>) {
    const result = await super.put(...args);
    this.save();
    return result;
  }

  override async putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
    await super.putWrites(...args);
    this.save();
  }

  override async deleteThread(threadId: string) {
    await super.deleteThread(threadId);
    this.save();
  }
}
