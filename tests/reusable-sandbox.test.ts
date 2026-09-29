import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import type { DemoConfig } from "../src/config.js";
import { prepareReusableSandbox, stopReusableSandbox, type LifecycleDependencies } from "../src/reusable-sandbox.js";
import { classifyBoxMountStatus, REMOTE_MOUNT_PATH } from "../src/sandbox.js";
import { withDemoLock, type DemoState } from "../src/state.js";

const config: DemoConfig = {
  daytonaApiKey: "test-daytona", boxAccessToken: "test-box", boxFolderId: "123",
  boxReviewerUserId: "", openaiApiKey: "test-openai", openaiModel: "test-model",
};
const saved: DemoState = {
  sandboxId: "saved", boxFolderId: "123", mountPath: REMOTE_MOUNT_PATH,
  outputPath: `${REMOTE_MOUNT_PATH}/Reviewed/Acme-MSA-review.md`,
  createdAt: "2026-09-29T00:00:00Z", expiresAt: null, reusable: true,
  boxMountVersion: "Box Mount 0.6.0", mountState: "mounted",
};
const runningStatus = `${REMOTE_MOUNT_PATH} | box_folder_id=123 | pid=624 | status=running`;

function harness(initial: DemoState | null = saved, currentState = "started") {
  let state = initial ? structuredClone(initial) : null;
  const writes: DemoState[] = [];
  const events: string[] = [];
  let present = initial !== null;
  let mounted = initial?.mountState !== "unmounted" && initial !== null;
  const start = mock.fn(async () => { events.push("start"); });
  const stop = mock.fn(async () => { events.push("stop"); });
  const deletion = mock.fn(async () => { throw new Error("must never delete"); });
  const sandbox = {
    id: "saved", state: currentState, start, stop, delete: deletion,
    setAutoDeleteInterval: mock.fn(async (n: number) => { events.push(`delete:${n}`); }),
    setTtl: mock.fn(async (n: number) => { events.push(`ttl:${n}`); }),
    setAutostopInterval: mock.fn(async (n: number) => { events.push(`autostop:${n}`); }),
    process: { executeCommand: mock.fn(async () => ({ exitCode: present ? 0 : 1, result: "" })) },
  } as unknown as Sandbox;
  const deps: LifecycleDependencies = {
    readState: async () => state ? structuredClone(state) : null,
    writeState: async value => { state = structuredClone(value); writes.push(structuredClone(value)); },
    connectSandbox: mock.fn(async () => sandbox),
    createDemoSandbox: mock.fn(async () => sandbox),
    installBoxMount: mock.fn(async () => { events.push("install"); present = true; return "Box Mount 0.6.0"; }),
    runCommand: mock.fn(async () => ({ stdout: "Box Mount 0.6.0\n" })),
    validateSandboxBoxSecret: mock.fn(async () => { events.push("validate-secret"); }),
    mountBox: mock.fn(async () => { events.push("mount"); mounted = true; }),
    unmountBox: mock.fn(async () => { events.push("unmount"); }),
    boxMountStatus: mock.fn(async () => mounted ? runningStatus : "No mount found."),
  };
  return { deps, sandbox, start, stop, deletion, events, writes, state: () => state };
}

test("initial setup saves recoverable state before installation and marks the completed mount", async () => {
  const h = harness(null);
  h.deps.installBoxMount = async () => {
    assert.equal(h.state()?.sandboxId, "saved");
    assert.equal(h.state()?.mountState, "unmounted");
    return "Box Mount 0.6.0";
  };
  assert.equal(await prepareReusableSandbox(config, h.deps), h.sandbox);
  assert.equal(h.state()?.expiresAt, null);
  assert.equal(h.state()?.boxMountVersion, "Box Mount 0.6.0");
  assert.equal(h.state()?.mountState, "mounted");
  assert.ok(h.writes.some(s => s.mountState === "unknown"));
  assert.equal(h.deletion.mock.callCount(), 0);
});

test("a second request reuses the binary and running mount without unmounting or bootstrapping", async () => {
  const h = harness();
  h.deps.createDemoSandbox = async () => { throw new Error("must not create"); };
  h.deps.installBoxMount = async () => { throw new Error("must not upload"); };
  await prepareReusableSandbox(config, h.deps);
  assert.deepEqual(h.events, ["delete:-1", "ttl:0", "autostop:0", "validate-secret"]);
  assert.equal(h.start.mock.callCount(), 0);
});

test("status parser recognizes verified CLI output and rejects ambiguous or wrong mounts", () => {
  assert.equal(classifyBoxMountStatus(`${runningStatus}\n`, "123"), "running");
  assert.equal(classifyBoxMountStatus("No mount found.\n", "123"), "absent");
  assert.equal(classifyBoxMountStatus(runningStatus.replace("running", "stopped"), "123"), "unhealthy");
  assert.equal(classifyBoxMountStatus(runningStatus.replace("pid=624", "pid=0"), "123"), "unhealthy");
  for (const output of ["", "mounted", "running", "{}", `${runningStatus}\nwarning`,
    runningStatus.replace(REMOTE_MOUNT_PATH, "/somewhere-else"), runningStatus.replace("folder_id=123", "folder_id=456"),
    `${runningStatus}\n${runningStatus}`]) {
    assert.equal(classifyBoxMountStatus(output, "123"), "unknown", output);
  }
});

test("live running status takes precedence over stale local mount state", async () => {
  for (const mountState of ["unknown", "unmounted"] as const) {
    const h = harness({ ...saved, mountState });
    h.deps.boxMountStatus = async () => runningStatus;
    await prepareReusableSandbox(config, h.deps);
    assert.equal(h.state()?.mountState, "mounted");
    assert.ok(!h.events.includes("mount") && !h.events.includes("unmount"));
  }
});

test("an absent mount is created even when the saved state says mounted", async () => {
  const h = harness();
  let calls = 0;
  h.deps.boxMountStatus = async () => calls++ === 0 ? "No mount found." : runningStatus;
  await prepareReusableSandbox(config, h.deps);
  assert.ok(h.events.includes("mount"));
  assert.ok(!h.events.includes("unmount"));
  assert.equal(h.state()?.mountState, "mounted");
});

test("unhealthy, unknown, or failed status checks preserve the sandbox without remounting", async () => {
  for (const output of ["", runningStatus.replace("running", "stopped"), "unexpected format", null]) {
    const h = harness();
    h.deps.boxMountStatus = async () => {
      if (output === null) throw new Error("status command failed");
      return output;
    };
    await assert.rejects(prepareReusableSandbox(config, h.deps), /no automatic unmount\/reset/);
    assert.equal(h.state()?.mountState, "unknown");
    assert.ok(!h.events.includes("mount") && !h.events.includes("unmount"));
    assert.equal(h.deletion.mock.callCount(), 0);
  }
});

test("successful mount command alone does not mark setup healthy", async () => {
  const h = harness({ ...saved, mountState: "unmounted" });
  h.deps.boxMountStatus = async () => "No mount found.";
  await assert.rejects(prepareReusableSandbox(config, h.deps), /did not report a running mount/);
  assert.equal(h.state()?.mountState, "unknown");
  assert.equal(h.deletion.mock.callCount(), 0);
});

test("stopped and archived sandboxes start with their installed binary intact", async () => {
  for (const lifecycle of ["stopped", "archived"]) {
    const h = harness({ ...saved, mountState: "unmounted" }, lifecycle);
    h.deps.installBoxMount = async () => { throw new Error("must not install"); };
    await prepareReusableSandbox(config, h.deps);
    assert.equal(h.start.mock.callCount(), 1);
    assert.ok(!h.events.includes("unmount"));
    assert.ok(h.events.includes("mount"));
  }
});

test("setup failure retains the sandbox ID and can retry an incomplete installation", async () => {
  const h = harness(null);
  const install = h.deps.installBoxMount;
  h.deps.installBoxMount = async () => { throw new Error("upload timed out"); };
  await assert.rejects(prepareReusableSandbox(config, h.deps), /upload timed out/);
  assert.equal(h.state()?.mountState, "unmounted");
  assert.equal(h.state()?.boxMountVersion, undefined);
  assert.equal(h.deletion.mock.callCount(), 0);
  h.deps.createDemoSandbox = async () => { throw new Error("must reconnect"); };
  h.deps.installBoxMount = install;
  await prepareReusableSandbox(config, h.deps);
  assert.equal(h.state()?.mountState, "mounted");
});

test("failed bootstrap is recorded as uncertain and never destroys the sandbox", async () => {
  const h = harness({ ...saved, mountState: "unmounted" });
  h.deps.mountBox = async () => { throw new Error("bootstrap failed"); };
  await assert.rejects(prepareReusableSandbox(config, h.deps), /bootstrap failed/);
  assert.equal(h.state()?.mountState, "unknown");
  assert.equal(h.deletion.mock.callCount(), 0);
});

test("folder mismatch and legacy state fail before any remote access", async () => {
  for (const initial of [{ ...saved, boxFolderId: "different" }, { ...saved, reusable: undefined }]) {
    const h = harness(initial);
    h.deps.connectSandbox = async () => { throw new Error("must not connect"); };
    await assert.rejects(prepareReusableSandbox(config, h.deps), /configuration|old lifecycle/);
    assert.equal(h.writes.length, 0);
  }
});

test("a deleted saved sandbox requires explicit recovery, not silent replacement", async () => {
  const h = harness();
  h.deps.connectSandbox = async () => { throw new DaytonaNotFoundError("deleted"); };
  h.deps.createDemoSandbox = async () => { throw new Error("must not create"); };
  await assert.rejects(prepareReusableSandbox(config, h.deps), /No replacement was created/);
  assert.equal(h.state()?.sandboxId, saved.sandboxId);
});

test("transitional states, failed authentication, and changed binaries do not launch a review workspace", async () => {
  const starting = harness(saved, "starting");
  await assert.rejects(prepareReusableSandbox(config, starting.deps), /stable state/);
  const auth = harness();
  auth.deps.validateSandboxBoxSecret = async () => { throw new Error("bad secret"); };
  await assert.rejects(prepareReusableSandbox(config, auth.deps), /bad secret/);
  const version = harness();
  version.deps.runCommand = async () => ({ stdout: "Box Mount 9.0.0" });
  await assert.rejects(prepareReusableSandbox(config, version.deps), /version does not match/);
  for (const h of [starting, auth, version]) assert.ok(!h.events.includes("mount"));
});

test("stop disables deletion, completes unmount, saves state, then stops without deleting", async () => {
  const h = harness();
  h.stop.mock.mockImplementation(async () => {
    assert.equal(h.state()?.mountState, "unmounted");
    h.events.push("stop");
  });
  await stopReusableSandbox(config.daytonaApiKey, h.deps);
  assert.deepEqual(h.events, ["delete:-1", "ttl:0", "unmount", "stop"]);
  assert.equal(h.state()?.sandboxId, saved.sandboxId);
  assert.equal(h.deletion.mock.callCount(), 0);
});

test("failed final sync prevents stop and retains mount state for recovery", async () => {
  const h = harness();
  h.deps.unmountBox = async () => { throw new Error("sync failed"); };
  await assert.rejects(stopReusableSandbox(config.daytonaApiKey, h.deps), /sync failed/);
  assert.equal(h.stop.mock.callCount(), 0);
  assert.equal(h.state()?.mountState, "mounted");
  assert.equal(h.deletion.mock.callCount(), 0);
});

test("already-stopped and partially installed sandboxes can be retained without a bogus unmount", async () => {
  for (const lifecycle of ["started", "stopped", "archived"]) {
    const h = harness({ ...saved, mountState: "unmounted" }, lifecycle);
    h.deps.unmountBox = async () => { throw new Error("must not unmount"); };
    await stopReusableSandbox(config.daytonaApiKey, h.deps);
    assert.equal(h.stop.mock.callCount(), lifecycle === "started" ? 1 : 0);
    assert.equal(h.deletion.mock.callCount(), 0);
  }
});

test("lifecycle lock excludes overlapping commands and releases after success or failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "daytona-lock-test-"));
  const lock = join(directory, "session.lock");
  try {
    await withDemoLock(async () => {
      assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
      await assert.rejects(withDemoLock(async () => {}, lock), /Another lifecycle command/);
    }, lock);
    await assert.rejects(withDemoLock(async () => { throw new Error("run failed"); }, lock), /run failed/);
    assert.equal(await withDemoLock(async () => "recovered", lock), "recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
