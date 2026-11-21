import assert from "node:assert/strict";
import test from "node:test";
import { createTools } from "../dist/tools.js";
import { NativeError } from "../dist/native.js";
import { containsSensitiveText } from "../dist/redaction.js";

function fixture(extra = {}) {
  const files = new Map(Object.entries({
    "Alpha.txt": "alpha\r\nbeta\ngamma",
    "Sources/Cafe\u0301.txt": "inside a directory",
    "Sources/Nested/deep.txt": "literal needle in a body",
    "Sources/Nested/a[1].txt": "a filename with punctuation",
    "Sources/.hidden/note.txt": "ignored",
    "Sources/Node_Modules/dependency.txt": "ignored",
    "Sources/BuIlD/artifact.txt": "ignored",
    "Sources/ID_ED25519": "ignored",
    "Sources/cert.PEM": "ignored",
    "Sources/old.key": "ignored",
    "Sources/bad\\name.txt": "ignored",
    ...extra
  }));
  const paths = new Map([[".", "directory"], ["shortcut", "other"]]);
  for (const file of files.keys()) {
    paths.set(file, "file");
    const names = file.split("/");
    names.pop();
    while (names.length) {
      paths.set(names.join("/"), "directory");
      names.pop();
    }
  }
  const observed = { inspect: [], list: [], read: [] };
  const identity = { dev: "1", ino: "2" };
  const root = {
    async inspect(path) {
      observed.inspect.push(path);
      if (!paths.has(path)) throw new NativeError("NOT_FOUND");
      return { type: paths.get(path), ...identity };
    },
    async list(path, expected) {
      observed.list.push(path);
      assert.equal(expected.type, "directory");
      assert.equal(expected.ino, identity.ino);
      const prefix = path === "." ? "" : path + "/";
      return [...paths.keys()].filter((key) => key !== "." && key.startsWith(prefix)
        && !key.slice(prefix.length).includes("/")).map((key) => key.slice(prefix.length));
    },
    async read(path, expected) {
      observed.read.push(path);
      assert.equal(expected.type, "file");
      assert.equal(expected.ino, identity.ino);
      const value = files.get(path);
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    }
  };
  return { root, observed };
}

function decoded(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text);
}

function error(result, code) {
  assert.deepEqual(result, { isError: true, content: [{ type: "text", text: code }] });
}

test("list depth, path validation and name filters apply before metadata inspection", async () => {
  const { root, observed } = fixture();
  const tools = createTools(root);
  assert.deepEqual(decoded(await tools.call("list_files", {})), {
    entries: [
      { path: "Alpha.txt", type: "file" },
      { path: "Sources", type: "directory" }
    ],
    nextCursor: null
  });
  for (const path of ["/abs", "../outside", "C:/x", "Sources//x", "Sources/./x", "bad\\x", "a\0b"]) {
    error(await tools.call("read_file", { path }), "INVALID_ARGUMENT");
  }
  for (const path of ["Sources/.hidden/note.txt", "Sources/Node_Modules/dependency.txt", "Sources/ID_ED25519"]) {
    error(await tools.call("read_file", { path }), "BLOCKED");
  }
  const { entries } = decoded(await tools.call("list_files", { path: "Sources", depth: 8 }));
  assert.deepEqual(entries.map(({ path }) => path), [
    "Sources/Cafe\u0301.txt", "Sources/Nested", "Sources/Nested/a[1].txt", "Sources/Nested/deep.txt"
  ]);
  assert.deepEqual(observed.read, []);
  assert.deepEqual(observed.inspect, [
    ".", "Alpha.txt", "Sources", "shortcut", "Sources", "Sources/Cafe\u0301.txt",
    "Sources/Nested", "Sources/Nested/a[1].txt", "Sources/Nested/deep.txt"
  ]);
});

test("find uses NFC and lower case on relative filename paths with literal matching", async () => {
  const { root, observed } = fixture();
  const tools = createTools(root);
  assert.deepEqual(decoded(await tools.call("find_files", { query: "SOURCES/CAFÉ.TXT" })).entries, [
    { path: "Sources/Cafe\u0301.txt", type: "file" }
  ]);
  assert.deepEqual(decoded(await tools.call("find_files", { query: "[1]" })).entries, [
    { path: "Sources/Nested/a[1].txt", type: "file" }
  ]);
  assert.deepEqual(decoded(await tools.call("find_files", { query: "literal needle" })).entries, []);
  assert.equal(observed.read.length, 0);
});

test("pagination is deterministic for a stable tree and cursors are query and session bound", async () => {
  const { root } = fixture();
  const tools = createTools(root);
  const first = decoded(await tools.call("find_files", { query: ".txt", limit: 2 }));
  assert.equal(typeof first.nextCursor, "string");
  error(await tools.call("find_files", { query: "deep", limit: 2, cursor: first.nextCursor }), "INVALID_ARGUMENT");
  error(await tools.call("find_files", {
    query: ".txt", limit: 2,
    cursor: (first.nextCursor[0] === "A" ? "B" : "A") + first.nextCursor.slice(1)
  }), "INVALID_ARGUMENT");
  error(await createTools(root).call("find_files", {
    query: ".txt", limit: 2, cursor: first.nextCursor
  }), "INVALID_ARGUMENT");
  const second = decoded(await tools.call("find_files", { query: ".txt", limit: 2, cursor: first.nextCursor }));
  assert.equal(new Set([...first.entries, ...second.entries].map(({ path }) => path)).size, 4);
  assert.equal(second.nextCursor, null);
});

test("read preserves line endings and classifies the complete file before returning any page", async () => {
  const marker = ["pass", "word"].join("");
  const { root } = fixture({
    "looks-safe.txt": `line one\n${marker} = example-only\n`,
    "invalid.txt": Buffer.from([0xff, 0xfe]),
    "nul.txt": Buffer.from([0x41, 0, 0x42]),
    "large-file.txt": Buffer.alloc(1024 * 1024 + 1, 0x41),
    "large-line.txt": "a".repeat(64 * 1024),
    "large-page.txt": ('"'.repeat(23000) + "\n").repeat(3)
  });
  const tools = createTools(root);
  const args = { path: "Alpha.txt", maxLines: 2 };
  assert.deepEqual(decoded(await tools.call("read_file", args)), {
    path: "Alpha.txt", content: "alpha\r\nbeta\n", nextLine: 3
  });
  assert.deepEqual(decoded(await tools.call("read_file", { ...args, startLine: 3 })), {
    path: "Alpha.txt", content: "gamma", nextLine: null
  });
  for (const path of ["looks-safe.txt", "invalid.txt", "nul.txt", "shortcut"]) {
    error(await tools.call("read_file", { path, maxLines: 1 }), "BLOCKED");
  }
  for (const path of ["large-file.txt", "large-line.txt"]) {
    error(await tools.call("read_file", { path }), "LIMIT_EXCEEDED");
  }
  const bounded = await tools.call("read_file", { path: "large-page.txt" });
  assert.ok(Buffer.byteLength(bounded.content[0].text) <= 65536);
  assert.equal(decoded(bounded).nextLine, 2);
});

test("sensitive text blocks original credential pattern families", () => {
  const values = [
    ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" "),
    "TOKEN=fixture",
    "EXAMPLE_ACCESS_TOKEN : fixture",
    "Authorization: placeholder",
    "Cookie: placeholder",
    "--api-key fixture",
    "Bearer syntheticDummy",
    "Basic " + Buffer.from("dummy:dummy").toString("base64"),
    "Bearer ,",
    "gh" + "p_" + "x".repeat(20),
    "machine test.invalid\n  login dummy\n  password dummy",
    "https://" + "dummy:dummy" + "@example.invalid/"
  ];
  for (const value of values) assert.equal(containsSensitiveText(value), true);
  assert.equal(containsSensitiveText("ordinary UTF-8 text"), false);
});

test("sensitive filenames are blocked before inspecting either spelling", async () => {
  const providerName = "Café." + "gh" + "p_" + "x".repeat(20) + ".txt";
  const alternate = providerName.toUpperCase().normalize("NFD");
  const { root, observed } = fixture({ [providerName]: "ordinary text" });
  const tools = createTools(root);
  for (const path of [providerName, alternate, "exampleApiKey=fixture", "EXAMPLEAPIKEY=FIXTURE"]) {
    error(await tools.call("read_file", { path }), "BLOCKED");
  }
  assert.deepEqual(observed.inspect, []);
  assert.deepEqual(observed.read, []);
});

test("traversal and failures stay bounded with fixed public error codes", async () => {
  const { root } = fixture();
  const limited = createTools({ ...root, async list() {
    return Array.from({ length: 8193 }, (_, index) => ".hidden" + index);
  } });
  error(await limited.call("find_files", { query: "absent" }), "LIMIT_EXCEEDED");
  const timed = createTools({ ...root, async list() { throw new NativeError("TIMEOUT"); } });
  error(await timed.call("list_files"), "LIMIT_EXCEEDED");
  const broken = createTools({ ...root, async read() { throw new Error("do not echo this"); } });
  error(await broken.call("read_file", { path: "Alpha.txt" }), "UNAVAILABLE");
  error(await broken.call("read_file", { path: "Alpha.txt", startLine: 0 }), "INVALID_ARGUMENT");
  error(await broken.call("list_files", { path: {}, extra: "do not echo this" }), "INVALID_ARGUMENT");
});

test("draining finishes the active operation and refuses new work", async () => {
  const { root } = fixture();
  let release;
  const tools = createTools({ ...root, read: () => new Promise((resolve) => { release = resolve; }) });
  const first = tools.call("read_file", { path: "Alpha.txt" });
  const stopped = tools.drain();
  error(await tools.call("read_file", { path: "Alpha.txt" }), "UNAVAILABLE");
  release(Buffer.from("completed"));
  assert.equal(decoded(await first).content, "completed");
  await stopped;
  error(await tools.call("list_files"), "UNAVAILABLE");
});
