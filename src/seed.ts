import type { Sandbox } from "@daytona/sdk";
import { FIXTURES_PATH, getDemoConfig } from "./config.js";
import { uploadFixtures } from "./fixtures.js";
import {
  boxMountStatus,
  createDemoSandbox,
  destroySandbox,
  disposeDaytona,
  installBoxMount,
  mountBox,
  unmountBox,
} from "./sandbox.js";

async function main(): Promise<void> {
  const config = getDemoConfig();
  let sandbox: Sandbox | undefined;
  let mounted = false;

  console.log("Creating a temporary Daytona sandbox...");

  try {
    sandbox = await createDemoSandbox(config, 15 * 60 * 1000);
    console.log(`Sandbox: ${sandbox.id}`);

    const version = await installBoxMount(
      sandbox,
      config.boxMountArchive,
    );
    console.log(`Installed ${version}`);

    console.log(`Mounting Box folder ${config.boxFolderId}...`);
    await mountBox(sandbox, config.boxFolderId);
    mounted = true;

    console.log("Copying the synthetic contract workspace...");
    const uploaded = await uploadFixtures(sandbox, FIXTURES_PATH);
    for (const path of uploaded) {
      console.log(`  ${path}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
    console.log(await boxMountStatus(sandbox));

    console.log("Finalizing synchronization...");
    await unmountBox(sandbox);
    mounted = false;
    console.log("Seed files are ready in Box.");
  } finally {
    if (sandbox && mounted) {
      await unmountBox(sandbox).catch((error: unknown) => {
        console.warn(
          `Warning: clean unmount failed: ${(error as Error).message}`,
        );
      });
    }
    if (sandbox) await destroySandbox(sandbox);
  }
}

main().catch((error: unknown) => {
  const message = (error as Error).message;
  if (message.includes("401") || message.toLowerCase().includes("auth")) {
    console.error(
      "\nSeed failed. Your Box Developer Token may have expired.\n" +
        "Check authentication and secret configuration. If the token expired, update BOX_ACCESS_TOKEN, run npm run secrets:sync, and retry.",
    );
  } else {
    console.error(`\nSeed failed:\n${message}`);
  }
  process.exitCode = 1;
}).finally(disposeDaytona);
