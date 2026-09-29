import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mock, test } from "node:test";
import type { Daytona, Sandbox } from "@daytona/sdk";
import { syncBoxSecret, validateSandboxBoxSecret } from "../src/box-secret.js";

function secretClient(pages: { items: { id: string; name: string }[]; nextCursor: string | null }[]) {
  let index = 0;
  const list = mock.fn(async (_query: unknown) => pages[index++]!);
  const create = mock.fn(async (_params: unknown) => ({}));
  const update = mock.fn(async (_id: string, _params: unknown) => ({}));
  const client = { secret: { list, create, update } } as unknown as Pick<Daytona, "secret">;
  return { client, list, create, update };
}

test("secret provisioning creates a narrowly allowlisted secret", async () => {
  const { client, create, update } = secretClient([{ items: [], nextCursor: null }]);
  assert.equal(await syncBoxSecret(client, " test-token "), "created");
  assert.deepEqual(create.mock.calls[0]!.arguments, [{
    name: "box-mount-token", value: "test-token", hosts: ["api.box.com", "upload.box.com"],
  }]);
  assert.equal(update.mock.callCount(), 0);
});

test("rotation selects an exact name across pages and reapplies the host allowlist", async () => {
  const { client, list, create, update } = secretClient([
    { items: [{ id: "other", name: "box-mount-token-other" }], nextCursor: "page2" },
    { items: [{ id: "target", name: "box-mount-token" }], nextCursor: null },
  ]);
  assert.equal(await syncBoxSecret(client, "new-token"), "updated");
  assert.deepEqual(list.mock.calls[1]!.arguments, [{ name: "box-mount-token", cursor: "page2" }]);
  assert.deepEqual(update.mock.calls[0]!.arguments, ["target", {
    value: "new-token", hosts: ["api.box.com", "upload.box.com"],
  }]);
  assert.equal(create.mock.callCount(), 0);
});

test("blank tokens and failed secret lookups do not trigger writes", async () => {
  const { client, list, create, update } = secretClient([]);
  await assert.rejects(syncBoxSecret(client, " \n"), /Missing BOX_ACCESS_TOKEN/);
  assert.equal(list.mock.callCount(), 0);
  list.mock.mockImplementation(async () => { throw new Error("permission denied"); });
  await assert.rejects(syncBoxSecret(client, "token"), /permission denied/);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
});

function sandboxChecks(results: { exitCode: number; result: string }[]) {
  let index = 0;
  const executeCommand = mock.fn(async (_command: string) => results[index++]!);
  const sandbox = { process: { executeCommand } } as unknown as Pick<Sandbox, "process">;
  return { sandbox, executeCommand };
}

test("doctor verifies the placeholder then uses a status-only authenticated request", async () => {
  const { sandbox, executeCommand } = sandboxChecks([
    { exitCode: 0, result: "" }, { exitCode: 0, result: "200" },
  ]);
  await validateSandboxBoxSecret(sandbox);
  const checkCommand = executeCommand.mock.calls[0]!.arguments[0];
  // Execute only the local environment-shape check, never the network request.
  assert.equal(execFileSync("sh", ["-c", checkCommand], {
    env: { PATH: process.env.PATH, BOX_ACCESS_TOKEN: "dtn_secret_test" }, encoding: "utf8",
  }), "");
  for (const value of ["", "real-token"]) {
    assert.throws(() => execFileSync("sh", ["-c", checkCommand], {
      env: { PATH: process.env.PATH, BOX_ACCESS_TOKEN: value }, stdio: "pipe",
    }));
  }
  const authCommand = executeCommand.mock.calls[1]!.arguments[0];
  assert.match(authCommand, /--output \/dev\/null/);
  assert.match(authCommand, /Bearer \$BOX_ACCESS_TOKEN/);
  assert.match(authCommand, /https:\/\/api\.box\.com\/2\.0\/users\/me/);
});

test("doctor rejects plaintext without attempting authentication or revealing diagnostics", async () => {
  const { sandbox, executeCommand } = sandboxChecks([{ exitCode: 1, result: "sensitive-value" }]);
  await assert.rejects(validateSandboxBoxSecret(sandbox), error => {
    assert.match(String(error), /not a Daytona secret placeholder/);
    assert.ok(!String(error).includes("sensitive-value"));
    return true;
  });
  assert.equal(executeCommand.mock.callCount(), 1);
});

test("doctor rejects denied authentication and network failures without raw output", async () => {
  for (const result of [{ exitCode: 0, result: "401" }, { exitCode: 60, result: "sensitive-value" }]) {
    const { sandbox } = sandboxChecks([{ exitCode: 0, result: "" }, result]);
    await assert.rejects(validateSandboxBoxSecret(sandbox), error => {
      assert.match(String(error), /authentication through Daytona Secrets failed/);
      assert.ok(!String(error).includes("sensitive-value"));
      return true;
    });
  }
});
