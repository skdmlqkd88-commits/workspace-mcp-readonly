import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { containsSensitiveFilename } from "./redaction.js";

export const MAX_PATH_BYTES = 4096;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_TRAVERSAL_ENTRIES = 8192;
export const TRAVERSAL_MS = 5000;

export type ErrorCode = "BLOCKED" | "INVALID_ARGUMENT" | "LIMIT_EXCEEDED" | "UNAVAILABLE";

export class ToolError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}

// Retain the source project's build/dependency and credential exclusions.
const EXCLUDED = new Set([
  "node_modules", "dist", "build", "_netrc", "_npmrc", "_pgpass",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json",
  "config.local.json", "oauth-state.json"
]);
const SENSITIVE_SUFFIX = /\.(?:pem|key|p12|pfx|jks|kdbx)$/u;
const INVALID_PATH_CHARACTER = /[\\\p{Cc}\p{Surrogate}]/u;

export function fold(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function checkRelativePath(path: string): void {
  if (path === ".") return;
  if (!path || Buffer.byteLength(path) > MAX_PATH_BYTES
    || INVALID_PATH_CHARACTER.test(path) || /^[A-Za-z]:/u.test(path)) {
    throw new ToolError("INVALID_ARGUMENT");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ToolError("INVALID_ARGUMENT");
  }
  if (segments.some((segment) => {
    const name = fold(segment);
    return name.startsWith(".") || EXCLUDED.has(name) || SENSITIVE_SUFFIX.test(name)
      || containsSensitiveFilename(name);
  })) {
    throw new ToolError("BLOCKED");
  }
}

const CURSOR_BYTES = 4 + 32;
export const CURSOR_LENGTH = Buffer.alloc(CURSOR_BYTES).toString("base64url").length;

// The offset is authenticated for this process and exact query, without retaining page state.
export class PageCursor {
  readonly #key = randomBytes(32);

  #sign(offset: Buffer, binding: string): Buffer {
    return createHmac("sha256", this.#key).update(offset).update(binding, "utf8").digest();
  }

  encode(offset: number, binding: string): string {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(offset);
    return Buffer.concat([bytes, this.#sign(bytes, binding)]).toString("base64url");
  }

  decode(value: string, binding: string): number {
    const bytes = Buffer.from(value, "base64url");
    const offset = bytes.subarray(0, 4);
    if (bytes.length !== CURSOR_BYTES || bytes.toString("base64url") !== value
      || !timingSafeEqual(bytes.subarray(4), this.#sign(offset, binding))) {
      throw new ToolError("INVALID_ARGUMENT");
    }
    const position = offset.readUInt32BE();
    if (position > MAX_TRAVERSAL_ENTRIES) throw new ToolError("INVALID_ARGUMENT");
    return position;
  }
}
