import { requireDaytonaApiKey } from "./config.js";
import { stopReusableSandbox } from "./reusable-sandbox.js";
import { disposeDaytona } from "./sandbox.js";
import { withDemoLock } from "./state.js";

withDemoLock(() => stopReusableSandbox(requireDaytonaApiKey())).catch((error: unknown) => {
  console.error(`Stop failed; sandbox was not deleted:\n${(error as Error).message}`);
  process.exitCode = 1;
}).finally(disposeDaytona);
