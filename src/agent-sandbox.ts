import { posix } from "node:path";
import type { Sandbox } from "@daytona/sdk";
import { Manifest, type SandboxSession } from "@openai/agents/sandbox";
import { REMOTE_MOUNT_PATH, shellQuote } from "./sandbox.js";

// Adapt the already-mounted sandbox. The demo, not the agent runner, owns
// its lifecycle; leaving out close/delete keeps it available for exploration.
export function createAgentSandboxSession(
  sandbox: Pick<Sandbox, "process">,
): SandboxSession {
  return {
    state: {
      manifest: new Manifest({ root: REMOTE_MOUNT_PATH }),
      workspaceReady: true,
    },
    supportsPty: () => false,
    async execCommand({ cmd, workdir, shell = "/bin/bash", login = true, tty, runAs, maxOutputTokens }) {
      if (tty || runAs) {
        throw new Error("This Daytona session supports non-interactive commands as the daytona user only.");
      }
      if (!["bash", "/bin/bash", "sh", "/bin/sh"].includes(shell)) {
        throw new Error("Use bash or sh in this Daytona session.");
      }
      const result = await sandbox.process.executeCommand(
        `${shellQuote(shell)} ${login ? "-lc" : "-c"} ${shellQuote(cmd)}`,
        posix.resolve(REMOTE_MOUNT_PATH, workdir || "."),
        undefined,
        60,
      );
      // Return failed command output to the agent so it can correct and retry.
      // Character-based truncation is approximate, not tokenizer accounting.
      const limit = Math.min(maxOutputTokens ?? 16_000, 16_000) * 4;
      const output = result.result.length > limit
        ? `${result.result.slice(0, limit)}\n[Output truncated; read smaller chunks.]`
        : result.result;
      return `Exit code: ${result.exitCode ?? "unknown"}\n${output}`;
    },
  };
}
