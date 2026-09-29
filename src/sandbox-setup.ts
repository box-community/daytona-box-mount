import { getDemoConfig } from "./config.js";
import { prepareReusableSandbox } from "./reusable-sandbox.js";
import { disposeDaytona } from "./sandbox.js";
import { withDemoLock } from "./state.js";

withDemoLock(async () => {
  await prepareReusableSandbox(getDemoConfig({ resolveArchive: false }));
  console.log("Reusable sandbox ready. Run npm run demo, or npm run stop when idle.");
}).catch((error: unknown) => {
  console.error(`Setup failed; any saved sandbox was retained:\n${(error as Error).message}`);
  process.exitCode = 1;
}).finally(disposeDaytona);
