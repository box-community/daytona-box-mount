import { requireDaytonaApiKey } from "./config.js";
import {
  REMOTE_MOUNT_PATH,
  boxMountStatus,
  connectSandbox,
  disposeDaytona,
  runCommand,
  shellQuote,
} from "./sandbox.js";
import { readState } from "./state.js";

async function main(): Promise<void> {
  const state = await readState();
  if (!state) {
    throw new Error("No active demo is registered. Run npm run demo.");
  }

  console.log(`Sandbox: ${state.sandboxId}`);
  console.log(`Box folder: ${state.boxFolderId}`);
  console.log(`Expected expiry: ${state.expiresAt ? new Date(state.expiresAt).toLocaleString() : "none (explicit teardown required)"}`);

  try {
    const sandbox = await connectSandbox(
      state.sandboxId,
      requireDaytonaApiKey(),
    );
    if (sandbox.state !== "started") {
      console.log(`Sandbox is ${sandbox.state}. Run npm run demo or npm run setup to start it; status did not restart it.`);
      return;
    }
    console.log(`\n${await boxMountStatus(sandbox)}`);

    const listing = await runCommand(
    sandbox,
      `ls -la ${shellQuote(REMOTE_MOUNT_PATH)} && ` +
        `ls -la ${shellQuote(`${REMOTE_MOUNT_PATH}/Reviewed`)}`,
      { timeoutMs: 30_000 },
    );
    console.log(`\nMounted workspace:\n${listing.stdout.trim()}`);
    console.log("\nOpen https://app.daytona.io/dashboard/sandboxes and select this sandbox.");
    console.log(`Path: ${REMOTE_MOUNT_PATH}`);
  } catch (error) {
    throw new Error(
      `The saved sandbox is no longer reachable.\n` +
        `Check Daytona connectivity and the sandbox in the dashboard.\n` +
        `If it was deleted, run npm run teardown to clear local state.\n\n` +
        `${(error as Error).message}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\nStatus failed:\n${(error as Error).message}`);
  process.exitCode = 1;
}).finally(disposeDaytona);
