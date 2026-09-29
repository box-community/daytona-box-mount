import { access } from "node:fs/promises";
import { join } from "node:path";
import { BoxApiError } from "box-node-sdk";
import type { Sandbox } from "@daytona/sdk";
import { validateBoxAccess } from "./box.js";
import { validateSandboxBoxSecret } from "./box-secret.js";
import { FIXTURES_PATH, getDemoConfig } from "./config.js";
import {
  createDemoSandbox,
  destroySandbox,
  disposeDaytona,
  installBoxMount,
} from "./sandbox.js";

async function validateOpenAi(
  apiKey: string,
  model: string,
): Promise<void> {
  // The agent harness now calls OpenAI from the host, not from Daytona.
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`OpenAI key check failed (${response.status}): ${await response.text()}`);
  }
  const payload = await response.json() as { data?: { id: string }[] };
  if (!payload.data?.some((entry) => entry.id === model)) {
    throw new Error(`OpenAI model is not available to this key: ${model}`);
  }
  console.log(`✓ OpenAI key works and can access ${model}`);
}

async function main(): Promise<void> {
  const config = getDemoConfig();
  await access(
    join(FIXTURES_PATH, "Incoming", "Acme-MSA.docx"),
  );
  await access(
    join(
      FIXTURES_PATH,
      "Playbook",
      "approved-contract-playbook.md",
    ),
  );

  console.log("✓ Configuration and fixtures found");
  const box = await validateBoxAccess(
    config.boxAccessToken,
    config.boxFolderId,
  );
  console.log(`✓ Box token works for ${box.user}`);
  console.log(`✓ Box folder is accessible: ${box.folder}`);

  let sandbox: Sandbox | undefined;
  try {
    console.log("Creating a short-lived Daytona compatibility check...");
    sandbox = await createDemoSandbox(config, 5 * 60 * 1000);
    await validateSandboxBoxSecret(sandbox);
    console.log("✓ Sandbox has a secret placeholder and Box accepts proxied authentication");
    await installBoxMount(
      sandbox,
      config.boxMountArchive,
    );
    console.log("✓ Daytona accepted the Box Mount Linux binary");
    await validateOpenAi(config.openaiApiKey, config.openaiModel);
  } finally {
    if (sandbox) await destroySandbox(sandbox);
  }

  console.log("\nSetup looks good. Next: npm run seed");
}

main().catch((error: unknown) => {
  if (
    error instanceof BoxApiError &&
    error.responseInfo.statusCode === 401
  ) {
    console.error(
      "\nDoctor failed:\nBox authentication failed. Your Developer Token " +
        "may have expired.\nGenerate a new token and update " +
        "BOX_ACCESS_TOKEN in .env, then run npm run secrets.",
    );
  } else {
    console.error(`\nDoctor failed:\n${(error as Error).message}`);
  }
  process.exitCode = 1;
}).finally(disposeDaytona);
