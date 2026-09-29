import type { Sandbox } from "@daytona/sdk";
import { getDemoConfig } from "./config.js";
import {
  REVIEW_OUTPUT_PATH,
} from "./contract-agent.js";
import { runReviewJob } from "./run-review-job.js";
import {
  REMOTE_MOUNT_PATH,
  SANDBOX_TIMEOUT_MS,
  boxMountStatus,
  createDemoSandbox,
  destroySandbox,
  disposeDaytona,
  installBoxMount,
  mountBox,
  unmountBox,
} from "./sandbox.js";
import {
  readState,
  removeState,
  writeState,
} from "./state.js";

async function main(): Promise<void> {
  const existing = await readState();
  if (existing) {
    throw new Error(
      `A demo is already registered (${existing.sandboxId}).\n` +
        "Run npm run status or npm run teardown before starting another.",
    );
  }

  const config = getDemoConfig();
  let sandbox: Sandbox | undefined;
  let mounted = false;
  let handedOff = false;
  let cleaningUp = false;

  const cleanupFailedRun = async (): Promise<void> => {
    if (cleaningUp || handedOff) return;
    cleaningUp = true;
    if (sandbox && mounted) {
      await unmountBox(sandbox).catch(() => undefined);
    }
    if (sandbox) {
      try {
        await destroySandbox(sandbox);
      } catch (error) {
        console.warn(
          `Cleanup failed for sandbox ${sandbox.id}; local state was retained.\n` +
            `Run npm run teardown to retry. ${(error as Error).message}`,
        );
        return;
      }
    }
    await removeState();
  };

  const onInterrupt = (): void => {
    console.log("\nInterrupted; cleaning up the incomplete demo...");
    void cleanupFailedRun().finally(() => process.exit(130));
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);

  try {
    console.log("Creating the Daytona contract-review sandbox...");
    sandbox = await createDemoSandbox(config);
    const createdAt = new Date();

    await writeState({
      sandboxId: sandbox.id,
      boxFolderId: config.boxFolderId,
      mountPath: REMOTE_MOUNT_PATH,
      outputPath: REVIEW_OUTPUT_PATH,
      createdAt: createdAt.toISOString(),
      expiresAt: sandbox.autoDestroyAt ?? new Date(
        createdAt.getTime() + SANDBOX_TIMEOUT_MS,
      ).toISOString(),
    });

    console.log(`Sandbox: ${sandbox.id}`);
    await installBoxMount(
      sandbox,
      config.boxMountArchive,
    );
    console.log("Installed Box Mount");

    console.log(`Mounting Box folder ${config.boxFolderId}...`);
    await mountBox(sandbox, config.boxFolderId);
    mounted = true;
    console.log(await boxMountStatus(sandbox));

    console.log(
      "OpenAI is reviewing Acme-MSA.docx against the approved playbook...",
    );
    console.log("The OpenAI SandboxAgent runs locally with shell tools in Daytona.");
    const { outputPath, taskAssignment } = await runReviewJob(
      sandbox,
      config,
    );

    handedOff = true;
    console.log("\nReview complete and synchronized to Box.");
    console.log(`Output: ${outputPath}`);
    if (taskAssignment === "assigned") {
      console.log("Box review task assigned to the configured reviewer.");
    } else if (taskAssignment === "skipped") {
      console.log(
        "No Box reviewer configured; review task assignment skipped.",
      );
    } else {
      console.warn(
        "Box review task could not be assigned. Confirm the reviewer ID " +
          "and that the reviewer can access the output file.",
      );
    }
    console.log(`Sandbox: ${sandbox.id}`);
    console.log(`Expires: ${new Date(sandbox.autoDestroyAt ?? createdAt.getTime() + SANDBOX_TIMEOUT_MS).toLocaleString()}`);
    console.log("\nThe sandbox remains running for exploration.");
    console.log("  npm run status");
    console.log("  npm run teardown");
  } catch (error) {
    await cleanupFailedRun();
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

main().catch((error: unknown) => {
  const message = (error as Error).message;
  if (
    message.includes("401") ||
    message.toLowerCase().includes("authentication")
  ) {
    console.error(
      "\nDemo failed. A Developer Token or API key may have expired or be invalid.\n" +
        "Refresh the relevant value in .env and retry.",
    );
  } else {
    console.error(`\nDemo failed:\n${message}`);
  }
  process.exitCode = 1;
}).finally(disposeDaytona);
