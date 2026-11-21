import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod, cp, link, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const entry = join(dist, "stdio.js");
const toolNames = ["find_files", "list_files", "read_file"];
const secret = "synthetic-fixture-only";
const toolTimeout = { timeout: 10_000 };

async function makeFixture(t) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "workspace-readonly-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  const docs = join(root, "docs");
  const scratch = join(parent, "scratch");
  await mkdir(docs, { recursive: true });
  await mkdir(scratch);
  await writeFile(join(docs, "guide.md"), "# Guide\nFirst line\nLast line\n");
  const outside = join(parent, "outside.txt");
  await writeFile(outside, "outside-root-fixture\n");
  return { parent, root, docs, scratch, outside };
}

function connectTo(fixture, startupEntry = entry) {
  const client = new Client({ name: "workspace-readonly-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [startupEntry, "--root", fixture.root],
    env: { TMPDIR: fixture.scratch },
    stderr: "pipe",
  });
  transport.stderr.resume();
  return { client, transport };
}

function callTool(client, name, args) {
  return client.callTool({ name, arguments: args }, undefined, toolTimeout);
}

function textOf(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

function decode(result) {
  assert.notEqual(result.isError, true);
  return JSON.parse(textOf(result));
}

async function assertDenied(call) {
  const result = await call;
  assert.equal(result.isError, true);
  assert.ok(textOf(result).length > 0);
  return result;
}

test("stdio exposes just three tools and supports list, search, and paged reads", { timeout: 25_000 }, async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(join(fixture.docs, "café.txt"), "fixture\n");
  const { client, transport } = connectTo(fixture);
  try {
    await client.connect(transport, toolTimeout);
    const { tools } = await client.listTools(undefined, toolTimeout);
    assert.deepEqual(tools.map(({ name }) => name).sort(), toolNames);
    const options = { depth: 2, limit: 1 };
    const first = decode(await callTool(client, "list_files", options));
    assert.equal(first.entries.length, 1);
    assert.equal(typeof first.nextCursor, "string");
    const second = decode(await callTool(client, "list_files", { ...options, cursor: first.nextCursor }));
    assert.equal(second.entries.length, 1);
    assert.equal(typeof second.nextCursor, "string");
    const third = decode(await callTool(client, "list_files", { ...options, cursor: second.nextCursor }));
    assert.equal(third.entries.length, 1);
    const paths = [...first.entries, ...second.entries, ...third.entries].map(({ path }) => path.normalize("NFC"));
    assert.deepEqual(paths.sort(), ["docs", "docs/café.txt", "docs/guide.md"]);
    assert.equal(third.nextCursor, null);
    await assertDenied(callTool(client, "list_files", { depth: 1, limit: 1, cursor: first.nextCursor }));

    const search = decode(await callTool(client, "find_files", { query: "CAFE\u0301" }));
    assert.deepEqual(search.entries.map(({ path, type }) => [path.normalize("NFC"), type]), [
      ["docs/café.txt", "file"],
    ]);
    const literal = decode(await callTool(client, "find_files", { query: "*" }));
    assert.deepEqual(literal.entries, []);
    const read = decode(await callTool(client, "read_file", { path: "docs/guide.md", maxLines: 1 }));
    assert.equal(read.content.trimEnd(), "# Guide");
    assert.equal(read.nextLine, 2);
    const remainder = decode(await callTool(client, "read_file", { path: read.path, startLine: read.nextLine }));
    assert.equal(remainder.content.trimEnd(), "First line\nLast line");
    assert.equal(remainder.nextLine, null);

    const unsupported = await callTool(client, "write_file", {}).catch((error) => error);
    assert.ok(unsupported instanceof Error || unsupported.isError === true);
  } finally {
    await client.close();
  }
});

test("stdio rejects out-of-scope, linked, and sensitive paths and content", { timeout: 25_000 }, async (t) => {
  const fixture = await makeFixture(t);
  await symlink(fixture.outside, join(fixture.root, "outside-link.txt"));
  await symlink(fixture.docs, join(fixture.root, "linked-docs"), "dir");
  await link(fixture.outside, join(fixture.root, "shared-inode.txt"));
  await writeFile(join(fixture.root, ".env"), "sensitive-path-fixture\n");
  await writeFile(join(fixture.root, "notes.txt"), "public-looking line\n\napi_key=" + secret + "\n");
  const { client, transport } = connectTo(fixture);
  try {
    await client.connect(transport, toolTimeout);
    for (const path of [fixture.outside, "../outside.txt", "outside-link.txt", "linked-docs/guide.md", "shared-inode.txt", ".env"]) {
      const denied = await assertDenied(callTool(client, "read_file", { path }));
      assert.doesNotMatch(textOf(denied), /outside-root-fixture|sensitive-path-fixture/u);
    }
    const denied = await assertDenied(callTool(client, "read_file", { path: "notes.txt", maxLines: 1 }));
    assert.doesNotMatch(textOf(denied), /public-looking line|synthetic-fixture-only/u);
    await assertDenied(callTool(client, "list_files", { path: "linked-docs" }));
    await assertDenied(callTool(client, "find_files", { path: "..", query: "outside" }));
    const list = decode(await callTool(client, "list_files", {}));
    assert.ok(!list.entries.some(({ path }) => path === ".env"));
    const find = decode(await callTool(client, "find_files", { query: ".env" }));
    assert.deepEqual(find.entries, []);
  } finally {
    await client.close();
  }
});

test("stdio enforces text and response size limits", { timeout: 25_000 }, async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(join(fixture.root, "nul.txt"), Buffer.from([0x41, 0, 0x42]));
  await writeFile(join(fixture.root, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(fixture.root, "over-limit.txt"), "a".repeat(1024 * 1024 + 1));
  await writeFile(join(fixture.root, "long-line.txt"), "a".repeat(80 * 1024));
  const nested = join(...Array.from({ length: 4 }, (_, index) => String(index).repeat(170)));
  await mkdir(join(fixture.root, nested), { recursive: true });
  await Promise.all(Array.from({ length: 100 }, (_, index) => (
    writeFile(join(fixture.root, nested, "fixture-" + index + ".txt"), "fixture\n")
  )));
  const { client, transport } = connectTo(fixture);
  try {
    await client.connect(transport, toolTimeout);
    for (const path of ["nul.txt", "invalid-utf8.txt", "over-limit.txt", "long-line.txt"]) {
      await assertDenied(callTool(client, "read_file", { path }));
    }
    const response = await callTool(client, "find_files", { query: "fixture-", depth: 5, limit: 100 });
    assert.ok(Buffer.byteLength(textOf(response), "utf8") <= 64 * 1024);
    const page = decode(response);
    assert.ok(page.entries.length > 0);
    assert.ok(page.entries.length < 100);
    assert.equal(typeof page.nextCursor, "string");
  } finally {
    await client.close();
  }
});

test("closing stdin exits the stdio process and clears its isolated helper scratch directory", { timeout: 15_000 }, async (t) => {
  const fixture = await makeFixture(t);
  const child = spawn(process.execPath, [entry, "--root", fixture.root], {
    env: { TMPDIR: fixture.scratch },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  const onTimeout = () => child.kill("SIGKILL");
  t.signal.addEventListener("abort", onTimeout, { once: true });
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "workspace-readonly-eof-test", version: "1.0.0" },
      },
    }) + "\n");
    const initialized = JSON.parse((await replies.next()).value);
    assert.equal(initialized.id, 1);
    assert.ok(initialized.result?.capabilities?.tools);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "docs/guide.md" } },
    }) + "\n");
    const read = JSON.parse((await replies.next()).value);
    assert.equal(read.id, 2);
    assert.equal(decode(read.result).path, "docs/guide.md");
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    assert.deepEqual(await readdir(fixture.scratch), []);
  } finally {
    lines.close();
    t.signal.removeEventListener("abort", onTimeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await closed;
  }
});

test("stdio fails closed if the isolated helper digest or protocol is wrong", { timeout: 25_000 }, async (t) => {
  const fixture = await makeFixture(t);
  const isolatedDist = join(fixture.parent, "dist");
  await cp(dist, isolatedDist, { recursive: true });
  await symlink(join(dirname(dist), "node_modules"), join(fixture.parent, "node_modules"), "dir");
  const copiedEntry = join(isolatedDist, "stdio.js");
  const helper = join(isolatedDist, "workspace-fs-helper");
  const marker = join(isolatedDist, "helper.sha256");

  const clean = connectTo(fixture, copiedEntry);
  try {
    await clean.client.connect(clean.transport, toolTimeout);
    decode(await callTool(clean.client, "read_file", { path: "docs/guide.md" }));
  } finally {
    await clean.client.close();
  }

  const differentProtocol = "#!/bin/sh\nprintf 'fixture-invalid-protocol\\n'\n";
  await writeFile(helper, differentProtocol);
  await chmod(helper, 0o755);

  async function checkUnavailable() {
    const attempt = connectTo(fixture, copiedEntry);
    try {
      const connectionError = await attempt.client.connect(attempt.transport, toolTimeout).catch((error) => error);
      if (!(connectionError instanceof Error)) {
        await assertDenied(callTool(attempt.client, "read_file", { path: "docs/guide.md" }));
      }
    } finally {
      await attempt.client.close();
    }
  }

  await checkUnavailable();
  const digest = createHash("sha256").update(differentProtocol).digest("hex");
  await writeFile(marker, digest + "\n");
  await checkUnavailable();
});
