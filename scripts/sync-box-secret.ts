import { BOX_SECRET_NAME, syncBoxSecret } from "../src/box-secret.js";
import { requireBoxAccessToken, requireDaytonaApiKey } from "../src/config.js";
import { disposeDaytona, getDaytona } from "../src/sandbox.js";

async function main(): Promise<void> {
  const token = requireBoxAccessToken();
  const result = await syncBoxSecret(getDaytona(requireDaytonaApiKey()), token);
  console.log(`Daytona secret ${BOX_SECRET_NAME} ${result} (api.box.com, upload.box.com).`);
}

main().catch(() => {
  // SDK errors can contain request details. Do not log the credential payload.
  console.error("Secret sync failed. Check BOX_ACCESS_TOKEN, DAYTONA_API_KEY, DAYTONA_API_URL, connectivity, and the manage:secrets permission. No plaintext fallback is used.");
  process.exitCode = 1;
}).finally(disposeDaytona);
