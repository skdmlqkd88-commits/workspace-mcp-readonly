import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const protocol = "workspace-readonly-fd-v1\n";
const helperSource = new URL("./workspace-fs-helper", import.meta.url);
const helperDigest = new URL("./helper.sha256", import.meta.url);
const maxHelperBytes = 16 * 1024 * 1024;
const maxReadBytes = 1024 * 1024;
const maxNames = 4096;
const maxNameBytes = 255;
const maxListBytes = 4 + maxNames * (4 + maxNameBytes);
const metadataBytes = 17;
const helperTimeoutMs = 3000;
const reapTimeoutMs = 1000;

type Identity = { dev: string; ino: string };
type Metadata = Identity & { type: "file" | "directory" | "other" };
type NativeErrorCode = "BLOCKED" | "NOT_FOUND" | "CHANGED" | "LIMIT" | "TIMEOUT" | "UNAVAILABLE";

const messages: Record<NativeErrorCode, string> = {
  BLOCKED: "The filesystem policy blocked this path.",
  NOT_FOUND: "The requested path is unavailable.",
  CHANGED: "The path changed during the filesystem operation.",
  LIMIT: "The filesystem operation exceeded a size limit.",
  TIMEOUT: "The filesystem operation exceeded its time limit.",
  UNAVAILABLE: "The verified filesystem helper is unavailable.",
};

export class NativeError extends Error {
  constructor(readonly code: NativeErrorCode) {
    super(messages[code]);
    this.name = "NativeError";
  }
}

class UnreapedHelperError extends NativeError {
  constructor(error: NativeError, readonly reaped: Promise<void>) {
    super(error.code);
  }
}

function identity(stat: BigIntStats): Identity {
  return { dev: BigInt.asUintN(64, stat.dev).toString(), ino: stat.ino.toString() };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.nlink === 1n && right.nlink === 1n;
}

function frame(fields: readonly string[]): Buffer {
  return Buffer.concat(fields.flatMap((field) => {
    const bytes = Buffer.from(field);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return [length, bytes];
  }));
}

function validateRelative(path: string): void {
  if (path === ".") return;
  if (path.length === 0 || /^[A-Za-z]:/u.test(path) || path.includes("\\") || path.includes("\0")
      || Buffer.byteLength(path) > 4096 || Buffer.from(path).toString("utf8") !== path
      || path.split("/").some((part) => part === "" || part === "." || part === ".." || Buffer.byteLength(part) > maxNameBytes)) {
    throw new NativeError("BLOCKED");
  }
}

function checkDeadline(deadline: number): void {
  if (performance.now() >= deadline) throw new NativeError("TIMEOUT");
}

function exitError(code: number | null): NativeError {
  switch (code) {
    case 10: return new NativeError("CHANGED");
    case 12: return new NativeError("NOT_FOUND");
    case 13: return new NativeError("BLOCKED");
    case 14:
    case 15: return new NativeError("LIMIT");
    default: return new NativeError("UNAVAILABLE");
  }
}

/* The watchdog owns the dedicated process group. The bridge only signals its direct child. */
function runHelper(
  executable: string,
  action: string,
  input: Buffer,
  rootFd: number | undefined,
  maxOutput: number,
  deadline: number,
): Promise<Buffer> {
  checkDeadline(deadline);
  return new Promise((fulfill, reject) => {
    const child = spawn(executable, [action], {
      detached: true,
      shell: false,
      env: {},
      stdio: ["pipe", "pipe", "ignore", rootFd ?? "ignore", "pipe"],
    });
    const parentControl = child.stdio[4];
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: NativeError | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let exited = false;
    let markReaped: () => void;
    const reaped = new Promise<void>((resolve) => { markReaped = resolve; });

    const stop = (error: NativeError): void => {
      if (failure !== undefined) return;
      failure = error;
      parentControl?.destroy();
      if (!exited) {
        child.kill("SIGKILL");
      }
      reapTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.unref();
        reject(new UnreapedHelperError(error, reaped));
      }, reapTimeoutMs);
    };
    const timer = setTimeout(() => stop(new NativeError("TIMEOUT")),
      Math.min(helperTimeoutMs, Math.max(1, Math.ceil(deadline - performance.now()))));
    child.once("exit", () => { exited = true; });
    child.once("error", () => stop(new NativeError("UNAVAILABLE")));
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => stop(new NativeError("UNAVAILABLE")));
    parentControl?.on("error", () => stop(new NativeError("UNAVAILABLE")));
    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) {
        stop(new NativeError("UNAVAILABLE"));
      } else if (failure === undefined) {
        chunks.push(chunk);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      parentControl?.destroy();
      markReaped?.();
      if (failure !== undefined) {
        reject(failure);
      } else if (code !== 0) {
        reject(exitError(code));
      } else {
        fulfill(Buffer.concat(chunks, outputBytes));
      }
    });
    if (child.stdin === null || child.stdout === null || parentControl == null) {
      stop(new NativeError("UNAVAILABLE"));
      return;
    }
    child.stdin.end(input);
  });
}

async function readTrustedFile(
  path: URL | string,
  limit: number,
  executable: boolean,
): Promise<{ bytes: Buffer; stat: BigIntStats }> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(limit) || stat.nlink !== 1n
        || (stat.mode & 0o022n) !== 0n || (executable && (stat.mode & 0o100n) === 0n)) {
      throw new NativeError("UNAVAILABLE");
    }
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await fd.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== Number(stat.size) || !sameFile(stat, await fd.stat({ bigint: true }))) {
      throw new NativeError("UNAVAILABLE");
    }
    return { bytes: bytes.subarray(0, length), stat };
  } finally {
    await fd.close();
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Snapshot = { path: string; directory: string; directoryStat: BigIntStats; stat: BigIntStats; digest: string };

async function checkSnapshotDirectory(directory: string, expected: BigIntStats): Promise<void> {
  const current = await lstat(directory, { bigint: true });
  if (!current.isDirectory() || current.uid !== BigInt(process.getuid?.() ?? -1)
      || (current.mode & 0o777n) !== 0o700n || !sameIdentity(current, expected)
      || await realpath(directory) !== directory) {
    throw new NativeError("UNAVAILABLE");
  }
}

async function validateSnapshot(snapshot: Snapshot): Promise<void> {
  await checkSnapshotDirectory(snapshot.directory, snapshot.directoryStat);
  const copy = await readTrustedFile(snapshot.path, maxHelperBytes, true);
  if (!sameFile(snapshot.stat, copy.stat) || sha256(copy.bytes) !== snapshot.digest) {
    throw new NativeError("UNAVAILABLE");
  }
}

async function removeSnapshot(snapshot: Pick<Snapshot, "path" | "directory" | "directoryStat">): Promise<void> {
  await checkSnapshotDirectory(snapshot.directory, snapshot.directoryStat);
  try {
    await unlink(snapshot.path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await rmdir(snapshot.directory);
}

async function verifiedTempRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new NativeError("UNAVAILABLE");
  const canonical = await realpath(path);
  const stat = await lstat(canonical, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid?.() ?? -1)
      || (stat.mode & 0o022n) !== 0n) throw new NativeError("UNAVAILABLE");
  return canonical;
}

async function privateTempRoot(): Promise<string> {
  try {
    return await verifiedTempRoot(tmpdir());
  } catch {
    // Local MCP clients may omit TMPDIR when starting a stdio server.
    const { stdout } = await promisify(execFile)("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      env: {}, timeout: helperTimeoutMs, maxBuffer: 4096,
    });
    return verifiedTempRoot(stdout.trim());
  }
}

async function snapshotHelper(): Promise<Snapshot> {
  const digest = (await readTrustedFile(helperDigest, 65, false)).bytes.toString("ascii");
  const expected = /^[a-f0-9]{64}\n$/u.test(digest) ? digest.slice(0, 64) : undefined;
  const source = await readTrustedFile(helperSource, maxHelperBytes, true);
  if (expected === undefined || sha256(source.bytes) !== expected) throw new NativeError("UNAVAILABLE");

  const temporaryRoot = await privateTempRoot();
  const directory = await mkdtemp(join(temporaryRoot, "workspace-readonly-"));
  const path = join(directory, "helper");
  const directoryStat = await lstat(directory, { bigint: true });
  await checkSnapshotDirectory(directory, directoryStat);
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
    try {
      await file.writeFile(source.bytes);
      await file.chmod(0o500);
    } finally {
      await file.close();
    }
    const copy = await readTrustedFile(path, maxHelperBytes, true);
    if (sha256(copy.bytes) !== expected) throw new NativeError("UNAVAILABLE");
    const snapshot = { directory, directoryStat, path, stat: copy.stat, digest: expected };
    await validateSnapshot(snapshot);
    const version = await runHelper(path, "--protocol-version", Buffer.alloc(0), undefined,
      Buffer.byteLength(protocol), Number.POSITIVE_INFINITY);
    if (!version.equals(Buffer.from(protocol))) throw new NativeError("UNAVAILABLE");
    return snapshot;
  } catch (error) {
    const cleanup = () => removeSnapshot({ path, directory, directoryStat });
    if (error instanceof UnreapedHelperError) {
      void error.reaped.then(cleanup).catch(() => undefined);
    } else {
      await cleanup().catch(() => undefined);
    }
    throw error;
  }
}

function parseList(reply: Buffer): string[] {
  if (reply.length < 4) throw new NativeError("UNAVAILABLE");
  const count = reply.readUInt32BE();
  if (count > maxNames) throw new NativeError("UNAVAILABLE");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const names: string[] = [];
  let offset = 4;

  for (let index = 0; index < count; index += 1) {
    if (reply.length - offset < 4) throw new NativeError("UNAVAILABLE");
    const size = reply.readUInt32BE(offset);
    offset += 4;
    if (size === 0 || size > maxNameBytes || size > reply.length - offset) {
      throw new NativeError("UNAVAILABLE");
    }
    const name = decoder.decode(reply.subarray(offset, offset + size));
    if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new NativeError("UNAVAILABLE");
    }
    if (!/^[A-Za-z]:/u.test(name) && !name.includes("\\")) names.push(name);
    offset += size;
  }
  if (offset !== reply.length) throw new NativeError("UNAVAILABLE");
  return names;
}

export class NativeRoot {
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #reapPending: Promise<void> | undefined;

  private constructor(
    private readonly rootPath: string,
    private readonly rootHandle: FileHandle,
    private readonly rootStat: BigIntStats,
    private readonly snapshot: Snapshot,
  ) {}

  static async open(absoluteRoot: string): Promise<NativeRoot> {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new NativeError("UNAVAILABLE");
    if (typeof absoluteRoot !== "string" || !isAbsolute(absoluteRoot)
        || absoluteRoot === sep || resolve(absoluteRoot) !== absoluteRoot) {
      throw new NativeError("BLOCKED");
    }
    let handle: FileHandle | undefined;
    try {
      if (await realpath(absoluteRoot) !== absoluteRoot) throw new NativeError("BLOCKED");
      const stat = await lstat(absoluteRoot, { bigint: true });
      if (!stat.isDirectory()) throw new NativeError("BLOCKED");
      handle = await open(absoluteRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!sameIdentity(stat, await handle.stat({ bigint: true }))) throw new NativeError("CHANGED");
      const snapshot = await snapshotHelper().catch(() => { throw new NativeError("UNAVAILABLE"); });
      const root = new NativeRoot(absoluteRoot, handle, stat, snapshot);
      try {
        await root.verifyRoot();
        return root;
      } catch (error) {
        await root.close().catch(() => undefined);
        handle = undefined;
        throw error;
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error instanceof NativeError ? error : new NativeError("BLOCKED");
    }
  }

  private async verifyRoot(): Promise<void> {
    try {
      const descriptor = await this.rootHandle.stat({ bigint: true });
      const named = await lstat(this.rootPath, { bigint: true });
      if (!descriptor.isDirectory() || !named.isDirectory() || !sameIdentity(this.rootStat, descriptor)
          || !sameIdentity(this.rootStat, named) || await realpath(this.rootPath) !== this.rootPath) {
        throw new NativeError("CHANGED");
      }
    } catch {
      throw new NativeError("CHANGED");
    }
  }

  private invoke<T>(
    action: string, fields: readonly string[], maxOutput: number,
    deadline: number, parse: (reply: Buffer) => T,
  ): Promise<T> {
    if (this.#closePromise !== undefined) return Promise.reject(new NativeError("UNAVAILABLE"));
    const run = this.#tail.then(async () => {
      try {
        if (this.#reapPending !== undefined) throw new NativeError("UNAVAILABLE");
        checkDeadline(deadline);
        validateRelative(fields[0] ?? "");
        await this.verifyRoot();
        await validateSnapshot(this.snapshot);
        const root = identity(this.rootStat);
        const reply = await runHelper(this.snapshot.path, action, frame([root.dev, root.ino, ...fields]),
          this.rootHandle.fd, maxOutput, deadline);
        checkDeadline(deadline);
        await this.verifyRoot();
        checkDeadline(deadline);
        return parse(reply);
      } catch (error) {
        if (error instanceof UnreapedHelperError) this.#reapPending = error.reaped;
        throw error instanceof NativeError ? error : new NativeError("UNAVAILABLE");
      }
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  inspect(relative: string, deadline = Number.POSITIVE_INFINITY): Promise<Metadata> {
    return this.invoke("inspect", [relative], metadataBytes, deadline, (reply) => {
      if (reply.length !== metadataBytes) throw new NativeError("UNAVAILABLE");
      const kind = reply[0];
      const type = kind === 1 ? "file" : kind === 2 ? "directory" : "other";
      if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4) throw new NativeError("UNAVAILABLE");
      return { type, dev: reply.readBigUInt64BE(1).toString(), ino: reply.readBigUInt64BE(9).toString() };
    });
  }

  list(relative: string, expected: Identity, deadline = Number.POSITIVE_INFINITY): Promise<string[]> {
    return this.invoke("list", [relative, expected.dev, expected.ino], maxListBytes, deadline, parseList);
  }

  async read(relative: string, expected: Identity, deadline = Number.POSITIVE_INFINITY): Promise<Buffer> {
    validateRelative(relative);
    const split = relative.lastIndexOf("/");
    const parent = split < 0 ? "." : relative.slice(0, split);
    return this.invoke("read", [parent, relative.slice(split + 1), expected.dev, expected.ino], maxReadBytes,
      deadline, (reply) => reply);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#tail.then(async () => {
      try {
        try {
          await this.rootHandle.close();
        } finally {
          if (this.#reapPending === undefined) {
            await removeSnapshot(this.snapshot);
          } else {
            void this.#reapPending.then(() => removeSnapshot(this.snapshot)).catch(() => undefined);
            throw new NativeError("UNAVAILABLE");
          }
        }
      } catch {
        throw new NativeError("UNAVAILABLE");
      }
    });
    return this.#closePromise;
  }
}
