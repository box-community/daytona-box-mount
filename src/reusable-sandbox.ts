import { DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import type { DemoConfig } from "./config.js";
import { validateSandboxBoxSecret } from "./box-secret.js";
import {
  boxMountStatus, classifyBoxMountStatus, connectSandbox, createDemoSandbox, installBoxMount,
  mountBox, REMOTE_BINARY, REMOTE_MOUNT_PATH, runCommand, shellQuote, unmountBox,
} from "./sandbox.js";
import { readState, writeState, type DemoState } from "./state.js";

const dependencies = {
  readState, writeState, connectSandbox, createDemoSandbox, installBoxMount,
  mountBox, unmountBox, boxMountStatus, runCommand, validateSandboxBoxSecret,
};
export type LifecycleDependencies = typeof dependencies;

function validateReusableState(state: DemoState, folderId = state.boxFolderId): void {
  if (!state.reusable) {
    throw new Error("The saved sandbox uses the old lifecycle. Run npm run teardown and create a fresh reusable sandbox; old credentials and TTLs are not migrated automatically.");
  }
  if (state.boxFolderId !== folderId || state.mountPath !== REMOTE_MOUNT_PATH) {
    throw new Error("Saved sandbox folder/path differs from this configuration. Restore the original configuration or explicitly tear down the old sandbox first.");
  }
}

async function reconnect(state: DemoState, apiKey: string, deps: LifecycleDependencies): Promise<Sandbox> {
  try {
    return await deps.connectSandbox(state.sandboxId, apiKey);
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) {
      throw new Error("The saved sandbox no longer exists. Run npm run teardown to clear its state, then npm run setup. No replacement was created.");
    }
    throw error;
  }
}

// Call under withDemoLock. Save each transition before doing remote work so
// failures never erase the sandbox ID or claim a partial setup is complete.
export async function prepareReusableSandbox(
  config: DemoConfig,
  deps: LifecycleDependencies = dependencies,
): Promise<Sandbox> {
  let state = await deps.readState();
  let sandbox: Sandbox;
  if (state) {
    validateReusableState(state, config.boxFolderId);
    console.log(`Reusing sandbox: ${state.sandboxId}`);
    sandbox = await reconnect(state, config.daytonaApiKey, deps);
  } else {
    console.log("Creating the reusable Daytona sandbox...");
    sandbox = await deps.createDemoSandbox(config);
    state = {
      sandboxId: sandbox.id, boxFolderId: config.boxFolderId,
      mountPath: REMOTE_MOUNT_PATH, outputPath: `${REMOTE_MOUNT_PATH}/Reviewed/Acme-MSA-review.md`,
      createdAt: new Date().toISOString(), expiresAt: null,
      reusable: true, mountState: "unmounted",
    };
    console.log(`Sandbox: ${sandbox.id}`);
    await deps.writeState(state);
  }

  if (sandbox.state === "stopped" || sandbox.state === "archived") {
    console.log("Starting the saved sandbox...");
    await sandbox.start(180);
  } else if (sandbox.state !== "started") {
    throw new Error(`Sandbox is ${sandbox.state}; wait for a stable state before retrying. It has been retained.`);
  }
  // Also repairs lifecycle settings changed outside the application.
  await sandbox.setAutoDeleteInterval(-1);
  await sandbox.setTtl(0);
  await sandbox.setAutostopInterval(0);
  state.expiresAt = null;
  await deps.writeState(state);
  await deps.validateSandboxBoxSecret(sandbox);

  const present = await sandbox.process.executeCommand(`test -e ${shellQuote(REMOTE_BINARY)}`, undefined, undefined, 30);
  if (present.exitCode === 1) {
    if (state.mountState !== "unmounted") {
      throw new Error("Box Mount is missing but a mount may still exist. Inspect the retained sandbox before reinstalling.");
    }
    await deps.installBoxMount(sandbox, config.boxMountArchive);
  } else if (present.exitCode !== 0) {
    throw new Error("Could not check the installed Box Mount executable. Sandbox retained; no upload attempted.");
  }
  const version = (await deps.runCommand(sandbox, `${shellQuote(REMOTE_BINARY)} --version`)).stdout.trim();
  if (!version || (state.boxMountVersion && state.boxMountVersion !== version)) {
    throw new Error("Installed Box Mount version does not match saved setup. Inspect the sandbox or explicitly recreate it.");
  }
  state.boxMountVersion = version;
  await deps.writeState(state);
  console.log(`Using installed ${version}`);

  const checkMount = async () => {
    const recovery = "Sandbox retained; no automatic unmount/reset attempted. Run npm run status and inspect Box Mount logs in /home/daytona/.box-mount/logs before retrying setup.";
    let output: string;
    try {
      output = await deps.boxMountStatus(sandbox);
    } catch (error) {
      state.mountState = "unknown";
      await deps.writeState(state);
      throw new Error(`Could not check Box Mount status. ${recovery}`, { cause: error });
    }
    const health = classifyBoxMountStatus(output, config.boxFolderId);
    if (health === "unknown" || health === "unhealthy") {
      state.mountState = "unknown";
      await deps.writeState(state);
      throw new Error(`Box Mount status is ${health}: ${output || "(empty output)"}. ${recovery}`);
    }
    return health;
  };

  // Inspect the live registry, not just the last saved transition. A running
  // daemon continuously syncs; restarting it would repeat bootstrap needlessly.
  if (await checkMount() === "running") {
    state.mountState = "mounted";
    await deps.writeState(state);
    console.log(`Reusing running Box Mount at ${REMOTE_MOUNT_PATH}`);
    return sandbox;
  }
  state.mountState = "unknown";
  await deps.writeState(state);
  console.log(`Mounting Box folder ${config.boxFolderId}...`);
  await deps.mountBox(sandbox, config.boxFolderId);
  if (await checkMount() !== "running") {
    throw new Error("Box Mount did not report a running mount after setup. Sandbox retained; run npm run status and inspect Box Mount logs before retrying.");
  }
  state.mountState = "mounted";
  await deps.writeState(state);
  console.log(`Box Mount is running at ${REMOTE_MOUNT_PATH}`);
  return sandbox;
}

export async function stopReusableSandbox(
  apiKey: string,
  deps: LifecycleDependencies = dependencies,
): Promise<void> {
  const state = await deps.readState();
  if (!state) throw new Error("No saved sandbox. Run npm run setup first.");
  validateReusableState(state);
  const sandbox = await reconnect(state, apiKey, deps);
  // Never stop with the previous delete-on-stop setting still enabled.
  await sandbox.setAutoDeleteInterval(-1);
  await sandbox.setTtl(0);
  state.expiresAt = null;
  await deps.writeState(state);
  if (sandbox.state === "stopped" || sandbox.state === "archived") {
    console.log(`Sandbox is already ${sandbox.state}; files and saved ID retained.`);
    return;
  }
  if (sandbox.state !== "started") throw new Error(`Cannot safely stop sandbox in state ${sandbox.state}. Retry when stable.`);
  if (state.mountState !== "unmounted") {
    console.log("Final sync and unmount before stopping...");
    await deps.unmountBox(sandbox); // If this fails, do not stop or delete.
    state.mountState = "unmounted";
    await deps.writeState(state);
  }
  await sandbox.stop(180);
  console.log("Sandbox stopped. Files and saved ID retained; npm run demo starts it again.");
}
