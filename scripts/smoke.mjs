import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../examples/project", import.meta.url));
const entry = fileURLToPath(new URL("../dist/stdio.js", import.meta.url));
const client = new Client({ name: "workspace-readonly-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, "--root", root],
});
const requestOptions = { timeout: 10_000 };

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, requestOptions);
  assert.notEqual(result.isError, true, name + " failed");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

try {
  await client.connect(transport, requestOptions);
  const { tools } = await client.listTools(undefined, requestOptions);
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["find_files", "list_files", "read_file"]);
  assert.deepEqual(await callTool("list_files", {}), {
    entries: [{ path: "docs", type: "directory" }],
    nextCursor: null,
  });
  assert.deepEqual(await callTool("find_files", { query: "GUIDE" }), {
    entries: [{ path: "docs/guide.md", type: "file" }],
    nextCursor: null,
  });
  const read = await callTool("read_file", { path: "docs/guide.md", maxLines: 1 });
  assert.equal(read.path, "docs/guide.md");
  assert.equal(read.content.trimEnd(), "# 예제 프로젝트");
  assert.equal(read.nextLine, 2);
} finally {
  await client.close();
}

console.log("Smoke check passed.");
