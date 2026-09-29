import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { resolveBoxMountArchive, type DemoConfig } from "./config.js";
import { BOX_SECRET_NAME } from "./box-secret.js";

export const REMOTE_BIN_DIR = "/usr/local/bin";
export const REMOTE_BINARY = `${REMOTE_BIN_DIR}/box-mount`;
export const REMOTE_DATA_PATH = "/home/daytona/.box-mount";
export const REMOTE_MOUNT_PATH = "/home/daytona/box-demo";

let daytona: Daytona | undefined;

export function getDaytona(apiKey: string): Daytona {
  daytona ??= new Daytona({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL?.trim() || undefined,
    target: process.env.DAYTONA_TARGET?.trim() || undefined,
    requestTimeoutMs: 180_000,
  });
  return daytona;
}

// Close SDK event connections without stopping the sandbox left for exploration.
export async function disposeDaytona(): Promise<void> {
  const client = daytona;
  daytona = undefined;
  await client?.[Symbol.asyncDispose]();
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function createDemoSandbox(
  config: DemoConfig,
  timeoutMs = 0,
): Promise<Sandbox> {
  return getDaytona(config.daytonaApiKey).create({
    language: "typescript",
    user: "daytona",
    snapshot: config.daytonaSnapshot,
    // Only a placeholder enters the sandbox. Daytona substitutes the token
    // outside the sandbox for HTTPS requests to the secret's allowed hosts.
    secrets: { BOX_ACCESS_TOKEN: BOX_SECRET_NAME },
    public: false,
    // Reviews persist until explicit teardown. Doctor/seed pass a finite TTL.
    domainAllowList: [
      '*.boxcdn.net',
      '*.box.com',
      '*.boxcloud.com',
      'registry.npmjs.org',
      'api.openai.com',
    ].join(','),
    ttlMinutes: Math.ceil(timeoutMs / 60_000),
    autoStopInterval: 0,
    autoDeleteInterval: timeoutMs === 0 ? -1 : 0,
    labels: {
      app: "daytona-box-mount-contract-review",
      box_folder_id: config.boxFolderId,
      reviewer: "openai",
    },
  }, { timeout: 180 });
}

export async function connectSandbox(
  sandboxId: string,
  apiKey: string,
): Promise<Sandbox> {
  // get() retrieves the existing sandbox without resetting its TTL or
  // silently restarting a stopped mount with expired credentials.
  return getDaytona(apiKey).get(sandboxId);
}

export async function destroySandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.delete(60, true);
  } catch (error) {
    // The TTL may have expired between reconnecting and requesting deletion.
    if (!(error instanceof DaytonaNotFoundError)) throw error;
  }
}

export async function runCommand(
  sandbox: Pick<Sandbox, "process">,
  command: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string }> {
  const result = await sandbox.process.executeCommand(
    `bash -lc ${shellQuote(command)}`,
    options.cwd,
    undefined,
    Math.ceil((options.timeoutMs ?? 30_000) / 1000),
  );
  // Daytona returns unsuccessful exit codes instead of throwing for them.
  if (result.exitCode !== 0) {
    throw new Error(
      `Sandbox command failed (exit ${result.exitCode ?? "unknown"}):\n` +
        (result.result.trim() || "No command output was returned."),
    );
  }
  return { stdout: result.result };
}

export async function writeSandboxFile(
  sandbox: Pick<Sandbox, "fs">,
  path: string,
  content: string | Buffer,
  timeoutMs = 120_000,
): Promise<void> {
  // uploadFile(string, path) means a *local filename* in Daytona, not text.
  await sandbox.fs.uploadFile(
    typeof content === "string" ? Buffer.from(content, "utf8") : content,
    path,
    Math.ceil(timeoutMs / 1000),
  );
}

export async function installBoxMount(
  sandbox: Sandbox,
  archivePath = resolveBoxMountArchive(),
): Promise<string> {
  console.log("Uploading Box Mount archive...");
  await writeSandboxFile(
    sandbox, "/tmp/box-mount.tar.gz", await readFile(archivePath), 180_000,
  );
  console.log("Uploading Box Mount installer...");
  await writeSandboxFile(
    sandbox,
    "/tmp/install-box-mount.py",
    await readFile(new URL("../scripts/install-box-mount.py", import.meta.url)),
  );

  console.log("Installing and checking Box Mount...");
  const result = await runCommand(sandbox, [
    "sudo -n python3 /tmp/install-box-mount.py /tmp/box-mount.tar.gz " +
      shellQuote(REMOTE_BIN_DIR),
    `${shellQuote(REMOTE_BINARY)} --version`,
  ].join(" && "), { timeoutMs: 120_000 });

  const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0];
  return version ? `Box Mount ${version}` : "Box Mount binary verified";
}

export async function mountBox(sandbox: Sandbox, boxFolderId: string): Promise<void> {
  await runCommand(sandbox, [
    `mkdir -p ${shellQuote(REMOTE_MOUNT_PATH)} &&`,
    shellQuote(REMOTE_BINARY),
    `--data-path ${shellQuote(REMOTE_DATA_PATH)}`,
    `mount ${shellQuote(REMOTE_MOUNT_PATH)} ${shellQuote(boxFolderId)}`,
  ].join(" "), { timeoutMs: 300_000 });
}

export async function unmountBox(sandbox: Sandbox): Promise<void> {
  await runCommand(sandbox, [
    shellQuote(REMOTE_BINARY),
    `--data-path ${shellQuote(REMOTE_DATA_PATH)}`,
    `unmount ${shellQuote(REMOTE_MOUNT_PATH)}`,
  ].join(" "), { timeoutMs: 300_000 });
}

export async function boxMountStatus(sandbox: Sandbox): Promise<string> {
  const result = await runCommand(sandbox, [
    shellQuote(REMOTE_BINARY),
    `--data-path ${shellQuote(REMOTE_DATA_PATH)}`,
    "status",
  ].join(" "));
  return result.stdout.trim();
}

// Box Mount 0.6.0 has human-readable status only (no JSON flag). Fail closed
// if its format changes; a successful command alone does not mean a live mount.
export function classifyBoxMountStatus(
  output: string, boxFolderId: string,
): "running" | "absent" | "unhealthy" | "unknown" {
  const status = output.trim();
  if (status === "No mount found.") return "absent";
  const match = status.match(/^([^\r\n|]+) \| box_folder_id=(\d+) \| pid=(\d+) \| status=([a-z]+)$/);
  if (!match || match[1] !== REMOTE_MOUNT_PATH || match[2] !== boxFolderId) return "unknown";
  return match[4] === "running" && Number(match[3]) > 0 ? "running" : "unhealthy";
}

export function remoteFixturePath(fixtureRoot: string, localPath: string): string {
  const path = relative(fixtureRoot, localPath).split(sep).join("/");
  return `${REMOTE_MOUNT_PATH}/${path}`;
}
