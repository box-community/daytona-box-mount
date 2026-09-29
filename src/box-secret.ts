import type { Daytona, Sandbox } from "@daytona/sdk";

export const BOX_SECRET_NAME = "box-mount-token";
const BOX_SECRET_HOSTS = ["api.box.com", "upload.box.com"];

// Explicit host-side setup only: normal sandbox creation must never send
// plaintext credentials or silently fall back if the secret is unavailable.
export async function syncBoxSecret(
  daytona: Pick<Daytona, "secret">,
  accessToken: string,
): Promise<"created" | "updated"> {
  const value = accessToken.trim();
  if (!value) throw new Error("Missing BOX_ACCESS_TOKEN");
  let cursor: string | undefined;
  do {
    const page = await daytona.secret.list({ name: BOX_SECRET_NAME, cursor });
    const existing = page.items.find(secret => secret.name === BOX_SECRET_NAME);
    if (existing) {
      await daytona.secret.update(existing.id, { value, hosts: BOX_SECRET_HOSTS });
      return "updated";
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  await daytona.secret.create({ name: BOX_SECRET_NAME, value, hosts: BOX_SECRET_HOSTS });
  return "created";
}

// Report only fixed diagnostics, never request headers or environment values.
export async function validateSandboxBoxSecret(
  sandbox: Pick<Sandbox, "process">,
): Promise<void> {
  const check = await sandbox.process.executeCommand(
    "bash -c 'case \"$BOX_ACCESS_TOKEN\" in dtn_secret_*) exit 0 ;; *) exit 1 ;; esac'",
    undefined, undefined, 10,
  );
  if (check.exitCode !== 0) {
    throw new Error("Sandbox BOX_ACCESS_TOKEN is not a Daytona secret placeholder. Create a fresh sandbox with Secrets enabled.");
  }
  const auth = await sandbox.process.executeCommand(
    'curl --silent --show-error --max-time 30 --output /dev/null --write-out "%{http_code}" ' +
      '--header "Authorization: Bearer $BOX_ACCESS_TOKEN" https://api.box.com/2.0/users/me',
    undefined, undefined, 40,
  );
  if (auth.exitCode !== 0 || auth.result.trim() !== "200") {
    throw new Error("Sandbox Box authentication through Daytona Secrets failed. Check token expiry, secret hosts, network/TLS settings, and curl availability; update .env and run npm run secrets:sync after rotating the token.");
  }
}
