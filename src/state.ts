import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { STATE_PATH } from "./config.js";

export type DemoState = {
  sandboxId: string;
  boxFolderId: string;
  mountPath: string;
  outputPath: string;
  createdAt: string;
  expiresAt: string | null;
  reusable?: boolean;
  boxMountVersion?: string;
  mountState?: "unmounted" | "mounted" | "unknown";
};

export async function readState(): Promise<DemoState | null> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as DemoState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeState(state: DemoState): Promise<void> {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, STATE_PATH);
}

// Serialize lifecycle changes and reviews from this checkout. A stale lock is
// deliberately not auto-reclaimed: a remote operation may still be running.
export async function withDemoLock<T>(
  action: () => Promise<T>,
  lockPath = `${STATE_PATH}.lock`,
): Promise<T> {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another lifecycle command owns ${lockPath}. If interrupted, verify that the local process and remote operation have finished before removing this stale lock.`);
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath);
  }
}

export async function removeState(): Promise<void> {
  await rm(STATE_PATH, { force: true });
}
