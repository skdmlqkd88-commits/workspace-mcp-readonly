import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { NativeError, NativeRoot } from "../dist/native.js";

const dist = new URL("../dist/", import.meta.url);

async function fixture(t) {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "workspace-readonly-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const path = join(temporary, "공개 예제");
  await mkdir(path);
  return { temporary, path };
}

function fails(code) {
  return (error) => error instanceof NativeError && error.code === code
    && !/[\\/]/u.test(error.message);
}

test("lists names and reads ordinary file bytes through a verified root handle", async (t) => {
  const { path } = await fixture(t);
  await writeFile(join(path, "한글.txt"), "UTF-8 예제\n");
  await mkdir(join(path, "folder"));
  const root = await NativeRoot.open(path);
  try {
    const metadata = await root.inspect(".");
    assert.equal(metadata.type, "directory");
    assert.deepEqual((await root.list(".", metadata)).sort(), ["folder", "한글.txt"]);
    const file = await root.inspect("한글.txt");
    assert.equal(file.type, "file");
    assert.equal((await root.read("한글.txt", file)).toString("utf8"), "UTF-8 예제\n");
  } finally {
    await root.close();
    await root.close();
  }
  await assert.rejects(root.inspect("."), fails("UNAVAILABLE"));
});

test("rejects invalid roots, traversal, symlinks, hard links, and changed identities", async (t) => {
  const { path, temporary } = await fixture(t);
  const outside = join(temporary, "outside");
  const outsideFile = join(outside, "example.txt");
  await mkdir(outside);
  await writeFile(outsideFile, "synthetic fixture");
  const dirAlias = join(temporary, "root-alias");
  await symlink(path, dirAlias);
  await symlink(outside, join(path, "dir-alias"));
  await symlink(outsideFile, join(path, "file-alias"));
  await link(outsideFile, join(path, "multi-link"));
  await writeFile(join(path, "example.txt"), "ordinary data");

  for (const candidate of ["", ".", "/", outsideFile, dirAlias, join(dirAlias, "nested")]) {
    await assert.rejects(NativeRoot.open(candidate), fails("BLOCKED"));
  }
  const root = await NativeRoot.open(path);
  try {
    for (const candidate of ["", "/example.txt", "../outside/example.txt", "a//b", "./example.txt", "a\\b", "a\0b"]) {
      await assert.rejects(root.inspect(candidate), fails("BLOCKED"));
    }
    const symlinkMetadata = await root.inspect("file-alias");
    assert.equal(symlinkMetadata.type, "other");
    await assert.rejects(root.read("file-alias", symlinkMetadata), fails("BLOCKED"));
    const hardLink = await root.inspect("multi-link");
    assert.equal(hardLink.type, "other");
    await assert.rejects(root.read("multi-link", hardLink), fails("BLOCKED"));
    await assert.rejects(root.inspect("dir-alias/example.txt"), fails("BLOCKED"));

    const file = await root.inspect("example.txt");
    await rename(join(path, "example.txt"), join(path, "original.txt"));
    await writeFile(join(path, "example.txt"), "changed");
    await assert.rejects(root.read("example.txt", file), fails("CHANGED"));
    await assert.rejects(root.inspect(".", performance.now() - 1), fails("TIMEOUT"));

    await rename(path, join(temporary, "old-root"));
    await mkdir(path);
    await assert.rejects(root.inspect("."), fails("CHANGED"));
  } finally {
    await root.close();
  }
});

test("enforces native file and directory bounds without returning partial bytes", async (t) => {
  const { path } = await fixture(t);
  const fd = await open(join(path, "large"), "w");
  try {
    await fd.truncate(1024 * 1024 + 1);
  } finally {
    await fd.close();
  }
  const many = join(path, "many");
  await mkdir(many);
  for (let first = 0; first < 4097; first += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 4097 - first) }, (_, index) => {
      return writeFile(join(many, String(first + index)), "");
    }));
  }
  const root = await NativeRoot.open(path);
  try {
    await assert.rejects(root.read("large", await root.inspect("large")), fails("LIMIT"));
    await assert.rejects(root.list("many", await root.inspect("many")), fails("LIMIT"));
  } finally {
    await root.close();
  }
});

function nativeCall(command, control, rootFd) {
  const child = spawn(fileURLToPath(new URL("workspace-fs-helper", dist)), [command], {
    detached: true,
    stdio: ["pipe", "pipe", "ignore", rootFd ?? "ignore", control ? "pipe" : "ignore"],
  });
  const chunks = [];
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      child.stdio[4]?.destroy();
      resolve({ code, signal, stdout: Buffer.concat(chunks) });
    });
  });
  return { child, result };
}

test("requires liveness control and a matching inherited root, and exposes only read operations", async (t) => {
  const { path } = await fixture(t);
  const supported = nativeCall("--protocol-version", true);
  supported.child.stdin.end();
  const version = await supported.result;
  assert.equal(version.code, 0);
  assert.equal(version.stdout.toString(), "workspace-readonly-fd-v1\n");

  const noControl = nativeCall("--protocol-version", false);
  noControl.child.stdin.end();
  assert.equal((await noControl.result).code, 20);

  const noParent = nativeCall("--protocol-version", true);
  noParent.child.stdio[4].end();
  const unwatched = await noParent.result;
  assert.equal(unwatched.signal, "SIGKILL");
  assert.equal(unwatched.stdout.length, 0);

  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const wrongIdentity = nativeCall("inspect", true, fd.fd);
    const incorrectFrame = Buffer.from([0, 0, 0, 1, 48, 0, 0, 0, 1, 48, 0, 0, 0, 1, 46]);
    wrongIdentity.child.stdin.end(incorrectFrame);
    const denied = await wrongIdentity.result;
    assert.equal(denied.code, 10);
    assert.equal(denied.stdout.length, 0);

    const probeWithUnexpectedInput = nativeCall("--protocol-version", true);
    probeWithUnexpectedInput.child.stdin.end("unexpected frame");
    const malformed = await probeWithUnexpectedInput.result;
    assert.equal(malformed.code, 20);
    assert.equal(malformed.stdout.length, 0);
    for (const command of ["create", "replace", "move", "delete", "--launch-with-identity", "--process-identity", "--signal-process-group"]) {
      const unsupported = nativeCall(command, true, fd.fd);
      unsupported.child.stdin.end();
      assert.equal((await unsupported.result).code, 13);
    }
  } finally {
    await fd.close();
  }
});

test("fails closed for a missing helper, a stale digest, and a wrong protocol", async (t) => {
  const { path, temporary } = await fixture(t);
  const modulePath = join(temporary, "native.mjs");
  const testHelper = join(temporary, "workspace-fs-helper");
  const digest = join(temporary, "helper.sha256");
  await copyFile(new URL("native.js", dist), modulePath);
  await writeFile(digest, "0".repeat(64) + "\n");
  const { NativeRoot: IsolatedRoot, NativeError: IsolatedError } = await import(pathToFileURL(modulePath).href);
  const unavailable = (error) => error instanceof IsolatedError && error.code === "UNAVAILABLE";
  await assert.rejects(IsolatedRoot.open(path), unavailable);

  await copyFile(new URL("workspace-fs-helper", dist), testHelper);
  await assert.rejects(IsolatedRoot.open(path), unavailable);

  const fake = Buffer.from("#!/bin/sh\nprintf 'unknown-protocol\\n'\n");
  await writeFile(testHelper, fake);
  await writeFile(digest, createHash("sha256").update(fake).digest("hex") + "\n");
  await assert.rejects(IsolatedRoot.open(path), unavailable);
});
