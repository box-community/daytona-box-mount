import { requireDaytonaApiKey } from "./config.js";
import { DaytonaNotFoundError } from "@daytona/sdk";
import {
  connectSandbox,
  destroySandbox,
  disposeDaytona,
  unmountBox,
} from "./sandbox.js";
import { readState, removeState, withDemoLock } from "./state.js";

async function main(): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log("No active demo is registered.");
    return;
  }

  console.log(`Reconnecting to ${state.sandboxId}...`);
  let sandbox;
  try {
    sandbox = await connectSandbox(
      state.sandboxId,
      requireDaytonaApiKey(),
    );
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) {
      await removeState();
      console.log("The sandbox no longer exists. Local state cleared.");
      return;
    }
    throw error;
  }

  try {
    if (sandbox.state === "started" && state.mountState !== "unmounted") {
      console.log("Running Box Mount's final sync and unmount...");
      await unmountBox(sandbox);
    } else if (sandbox.state !== "started") {
      console.warn(`Sandbox is ${sandbox.state}; final sync is unavailable.`);
    }
  } catch (error) {
    console.warn(
      `Warning: clean unmount failed; the sandbox will still be destroyed.\n` +
        `${(error as Error).message}`,
    );
  } finally {
    console.log("Destroying Daytona sandbox...");
    await destroySandbox(sandbox);
    await removeState();
  }

  console.log("Demo sandbox destroyed and local state cleared.");
}

withDemoLock(main).catch((error: unknown) => {
  console.error(`\nTeardown failed:\n${(error as Error).message}`);
  process.exitCode = 1;
}).finally(disposeDaytona);
