import { z } from "zod";

export const DEFAULT_TEST = "npm test";
export const DEFAULT_INSTALL = "npm ci --ignore-scripts --no-audit --no-fund";

// Whitelist, so shell operators are rejected without a blacklist and the verdict is the same under cmd.exe and /bin/sh. No quoting: wrap such a command in a script.
export const SAFE_COMMAND = /^[\w ./:=@,\\-]+$/;
export const isSafeCommand = (line: string) => line.trim() !== "" && SAFE_COMMAND.test(line);
export const safeCommand = (what = "command") =>
  z.string().refine(isSafeCommand, `${what} must be a plain command without shell operators`);

const cmd = safeCommand("test");
export const TestSpec = z.union([cmd, z.array(cmd).min(1)]);

// `test` is one command or a list that must all pass (a matrix).
export type Test = z.infer<typeof TestSpec>;
export const commands = (test: Test) => [test].flat();
