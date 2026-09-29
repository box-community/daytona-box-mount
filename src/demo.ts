import { getDemoConfig } from "./config.js";
import { prepareReusableSandbox } from "./reusable-sandbox.js";
import { runReviewJob } from "./run-review-job.js";
import { disposeDaytona } from "./sandbox.js";
import { withDemoLock } from "./state.js";

async function main(): Promise<void> {
  const config = getDemoConfig({ resolveArchive: false });
  const sandbox = await prepareReusableSandbox(config);
  console.log("Reviewing Acme-MSA.docx against the approved playbook...");
  console.log("The agent loop runs locally with shell tools in Daytona.");
  const { outputPath, taskAssignment } = await runReviewJob(sandbox, config);

  console.log("\nReview saved to the mounted workspace. Check Box to confirm synchronization.");
  console.log(`Output: ${outputPath}`);
  if (taskAssignment === "assigned") {
    console.log("Box review task assigned to the configured reviewer.");
  } else if (taskAssignment === "skipped") {
    console.log("No Box reviewer configured; review task assignment skipped.");
  } else {
    console.warn("Box review task could not be assigned. Confirm reviewer access and output synchronization.");
  }
  console.log(`Sandbox: ${sandbox.id}`);
  console.log("Sandbox retained with no automatic expiry. Running resources continue to incur charges.");
  console.log("Run npm run demo again to reuse it, npm run stop when idle, or npm run teardown to delete.");
}

withDemoLock(main).catch((error: unknown) => {
  console.error(`\nDemo failed; the saved sandbox was retained for inspection and retry:\n${(error as Error).message}`);
  console.error("For an expired Box token, update .env and run npm run secrets. Use npm run teardown only to delete the sandbox.");
  process.exitCode = 1;
}).finally(disposeDaytona);
