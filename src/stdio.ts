import { isAbsolute } from "node:path";
import process from "node:process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NativeRoot } from "./native.js";
import { createReadOnlyServer } from "./tools.js";

const STARTUP_ERROR = "UNAVAILABLE\n";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--root" || !args[1] || !isAbsolute(args[1])
    || args[1].includes("\0") || /\p{Surrogate}/u.test(args[1])) {
    process.stderr.write("INVALID_ARGUMENT\n");
    process.exitCode = 1;
    return;
  }

  const root = await NativeRoot.open(args[1]);
  try {
    const { server, drain } = createReadOnlyServer(root);
    const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 128 * 1024 });
    await new Promise<void>((resolve, reject) => {
      let stopping = false;
      let brokenOutput = false;

      function finish(): void {
        if (stopping) return;
        stopping = true;
        process.stdin.pause();
        void (async () => {
          try {
            await nextTurn();
            await drain();
            // Protocol callbacks enqueue the final response on the current turn.
            await nextTurn();
            if (!brokenOutput) await flushOutput();
          } finally {
            await server.close();
          }
        })().then(resolve, reject);
      }

      function outputError(): void {
        brokenOutput = true;
        finish();
      }

      transport.onclose = finish;
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.stdin.once("end", finish);
      process.stdin.once("close", finish);
      process.stdin.once("error", finish);
      process.stdout.on("error", outputError);
      void server.connect(transport).catch(reject);
    });
  } finally {
    await root.close();
  }
}

function flushOutput(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      process.stdout.destroy();
      resolve();
    }, 2000);
    process.stdout.write("", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

void run().catch(() => {
  process.stderr.write(STARTUP_ERROR);
  process.exitCode = 1;
});
