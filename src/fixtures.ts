import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Sandbox } from "@daytona/sdk";
import {
  REMOTE_MOUNT_PATH,
  remoteFixturePath,
  runCommand,
  shellQuote,
  writeSandboxFile,
} from "./sandbox.js";

const IGNORED_FIXTURE_FILES = new Set([".gitkeep", ".DS_Store"]);

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (
      entry.isFile() &&
      !IGNORED_FIXTURE_FILES.has(entry.name)
    ) {
      files.push(path);
    }
  }

  return files;
}

export async function uploadFixtures(
  sandbox: Sandbox,
  fixtureRoot: string,
): Promise<string[]> {
  const localFiles = await listFiles(fixtureRoot);
  const uploaded: string[] = [];

  for (const localPath of localFiles) {
    const remotePath = remoteFixturePath(fixtureRoot, localPath);
    await runCommand(
    sandbox,
      `mkdir -p ${shellQuote(posix.dirname(remotePath))}`,
      { timeoutMs: 30_000 },
    );

    const data = await readFile(localPath);
    await writeSandboxFile(sandbox, remotePath, data);
    uploaded.push(remotePath);
  }

  await runCommand(
    sandbox,
    `mkdir -p ${shellQuote(`${REMOTE_MOUNT_PATH}/Reviewed`)}`,
    { timeoutMs: 30_000 },
  );

  return uploaded;
}
