import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NativeError, type NativeRoot } from "./native.js";
import {
  checkRelativePath, fold, ToolError, PageCursor, CURSOR_LENGTH, MAX_PATH_BYTES,
  MAX_RESPONSE_BYTES, MAX_FILE_BYTES, MAX_TRAVERSAL_ENTRIES, TRAVERSAL_MS
} from "./policy.js";
import { containsSensitiveText } from "./redaction.js";

type Root = Pick<NativeRoot, "inspect" | "list" | "read">;
type Identity = Awaited<ReturnType<Root["inspect"]>>;
type Entry = { path: string; type: "file" | "directory" };

const pathSchema = z.string().min(1).max(MAX_PATH_BYTES);
const listOptions = {
  path: pathSchema.default("."),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().length(CURSOR_LENGTH).optional()
};
const listSchema = z.strictObject({
  ...listOptions,
  depth: z.number().int().min(1).max(8).default(1)
});
const findSchema = z.strictObject({
  ...listOptions,
  depth: z.number().int().min(1).max(8).default(4),
  query: z.string().min(1).max(512).refine((value) => !/[\p{Cc}\p{Surrogate}]/u.test(value))
});
const readSchema = z.strictObject({
  path: pathSchema,
  startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  maxLines: z.number().int().min(1).max(1000).default(200)
});

function tool(name: string, description: string, shape: z.ZodType) {
  return {
    name,
    description,
    inputSchema: { ...z.toJSONSchema(shape, { target: "draft-07", io: "input" }), type: "object" as const },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  };
}

const TOOLS = [
  tool("list_files", "List visible project files and directories below a relative path.", listSchema),
  tool("find_files", "Find regular files by a literal, case-insensitive substring of their relative paths.", findSchema),
  tool("read_file", "Read a page of lines from an allowed project text file.", readSchema)
];

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeText(bytes: Buffer): string {
  if (bytes.length > MAX_FILE_BYTES) throw new ToolError("LIMIT_EXCEEDED");
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new ToolError("BLOCKED");
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u.test(text) || containsSensitiveText(text)) {
    throw new ToolError("BLOCKED");
  }
  return text;
}

function success(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(error: unknown): CallToolResult {
  let code: ToolError["code"] = "UNAVAILABLE";
  if (error instanceof ToolError) {
    code = error.code;
  } else if (error instanceof NativeError) {
    switch (error.code) {
      case "BLOCKED":
      case "NOT_FOUND":
      case "CHANGED": code = "BLOCKED"; break;
      case "LIMIT":
      case "TIMEOUT": code = "LIMIT_EXCEEDED"; break;
    }
  }
  return { isError: true, content: [{ type: "text", text: code }] };
}

function byteLength(value: object): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function assertBudget(deadline: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolError("UNAVAILABLE");
  if (performance.now() >= deadline) throw new ToolError("LIMIT_EXCEEDED");
}

export function createTools(root: Root) {
  const pager = new PageCursor();
  let active: Promise<CallToolResult> | undefined;
  let closing = false;

  async function* scan(
    path: string, depth: number, deadline: number, signal?: AbortSignal
  ): AsyncGenerator<Entry> {
    let inspectedEntries = 0;
    const base = await root.inspect(path, deadline);
    assertBudget(deadline, signal);
    if (base.type !== "directory") throw new ToolError("BLOCKED");

    async function* visit(directory: string, identity: Identity, remaining: number): AsyncGenerator<Entry> {
      assertBudget(deadline, signal);
      const names = (await root.list(directory, identity, deadline)).sort();
      for (const name of names) {
        assertBudget(deadline, signal);
        inspectedEntries += 1;
        if (inspectedEntries > MAX_TRAVERSAL_ENTRIES) throw new ToolError("LIMIT_EXCEEDED");
        // Only one directory-entry name is accepted from the native listing.
        if (!name || name === "." || name === ".." || name.includes("/")) continue;
        const child = directory === "." ? name : `${directory}/${name}`;
        try {
          checkRelativePath(child);
        } catch (error) {
          if (error instanceof ToolError) continue;
          throw error;
        }
        let item: Identity;
        try {
          item = await root.inspect(child, deadline);
        } catch (error) {
          if (error instanceof NativeError
            && (error.code === "BLOCKED" || error.code === "NOT_FOUND" || error.code === "CHANGED")) continue;
          throw error;
        }
        assertBudget(deadline, signal);
        if (item.type === "other") continue;
        yield { path: child, type: item.type };
        if (item.type === "directory" && remaining > 1) {
          yield* visit(child, item, remaining - 1);
        }
      }
    }

    yield* visit(path, base, depth);
  }

  async function page(
    options: z.infer<typeof listSchema>, query: string | null, signal?: AbortSignal
  ): Promise<CallToolResult> {
    checkRelativePath(options.path);
    const binding = JSON.stringify([options.path, options.depth, options.limit, query]);
    const offset = options.cursor ? pager.decode(options.cursor, binding) : 0;
    const entries: Entry[] = [];
    let matched = 0;
    let nextCursor: string | null = null;
    const deadline = performance.now() + TRAVERSAL_MS;
    for await (const entry of scan(options.path, options.depth, deadline, signal)) {
      if (query !== null && (entry.type !== "file" || !fold(entry.path).includes(query))) continue;
      if (matched++ < offset) continue;
      const cursor = pager.encode(offset + entries.length + 1, binding);
      if (entries.length === options.limit
        || byteLength({ entries: [...entries, entry], nextCursor: cursor }) > MAX_RESPONSE_BYTES) {
        if (entries.length === 0) throw new ToolError("LIMIT_EXCEEDED");
        nextCursor = pager.encode(offset + entries.length, binding);
        break;
      }
      entries.push(entry);
    }
    return success({ entries, nextCursor });
  }

  async function read(
    options: z.infer<typeof readSchema>, signal?: AbortSignal
  ): Promise<CallToolResult> {
    checkRelativePath(options.path);
    const deadline = performance.now() + TRAVERSAL_MS;
    const identity = await root.inspect(options.path, deadline);
    assertBudget(deadline, signal);
    if (identity.type !== "file") throw new ToolError("BLOCKED");
    const text = decodeText(await root.read(options.path, identity, deadline));
    assertBudget(deadline, signal);
    const lines = text === "" ? [] : text.split(/(?<=\n)/u);
    const start = options.startLine - 1;
    let content = "";
    let nextLine: number | null = null;
    let index = start;
    while (index < lines.length && index - start < options.maxLines) {
      const candidate = content + lines[index]!;
      const cursor = index + 1 < lines.length ? index + 2 : null;
      if (byteLength({ path: options.path, content: candidate, nextLine: cursor }) > MAX_RESPONSE_BYTES) {
        if (index === start) throw new ToolError("LIMIT_EXCEEDED");
        break;
      }
      content = candidate;
      index += 1;
    }
    if (index < lines.length) nextLine = index + 1;
    return success({ path: options.path, content, nextLine });
  }

  async function execute(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    switch (name) {
      case "list_files": {
        const parsed = listSchema.safeParse(args ?? {});
        if (parsed.success) return page(parsed.data, null, signal);
        break;
      }
      case "find_files": {
        const parsed = findSchema.safeParse(args);
        if (parsed.success) return page(parsed.data, fold(parsed.data.query), signal);
        break;
      }
      case "read_file": {
        const parsed = readSchema.safeParse(args);
        if (parsed.success) return read(parsed.data, signal);
        break;
      }
    }
    throw new ToolError("INVALID_ARGUMENT");
  }

  return {
    list: () => TOOLS,
    call(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
      if (closing || active || signal?.aborted) return Promise.resolve(failure(new ToolError("UNAVAILABLE")));
      const pending = execute(name, args, signal).catch(failure);
      active = pending;
      void pending.then(() => { active = undefined; });
      return pending;
    },
    async drain(): Promise<void> {
      closing = true;
      await active;
    }
  };
}

export function createReadOnlyServer(root: Root) {
  const server = new Server({ name: "workspace-mcp-readonly", version: "0.1.0" }, {
    capabilities: { tools: {} }
  });
  const tools = createTools(root);
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, (request, { signal }) =>
    tools.call(request.params.name, request.params.arguments, signal));
  return { server, drain: tools.drain };
}
