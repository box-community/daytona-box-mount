import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, mock, test } from "node:test";
import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { OpenAIProvider } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall, modelError } from "@openai/agents/testing";
import { createAgentSandboxSession } from "../src/agent-sandbox.js";
import { getDemoConfig, type DemoConfig } from "../src/config.js";
import { uploadFixtures } from "../src/fixtures.js";
import { runContractAgent, REVIEW_OUTPUT_PATH } from "../src/contract-agent.js";
import {
  connectSandbox, createDemoSandbox, destroySandbox, disposeDaytona,
  REMOTE_MOUNT_PATH, runCommand, shellQuote, writeSandboxFile,
} from "../src/sandbox.js";

const config: DemoConfig = {
  daytonaApiKey: "test-daytona-key",
  boxAccessToken: "test-box-token",
  boxFolderId: "12345",
  boxReviewerUserId: "",
  openaiApiKey: "test-openai-key",
  openaiModel: "test-model",
  boxMountArchive: "/unused/archive.tgz",
};

afterEach(async () => {
  await disposeDaytona();
  mock.restoreAll();
});

// SDK methods are mocked at the network boundary. Polling mode prevents the
// SDK constructor opening an event socket with the intentionally fake key.
async function withoutEvents(work: () => Promise<void>): Promise<void> {
  const previous = process.env.DAYTONA_USE_DEPRECATED_POLLING;
  process.env.DAYTONA_USE_DEPRECATED_POLLING = "true";
  try {
    await work();
  } finally {
    await disposeDaytona();
    if (previous === undefined) delete process.env.DAYTONA_USE_DEPRECATED_POLLING;
    else process.env.DAYTONA_USE_DEPRECATED_POLLING = previous;
  }
}

function fakeSandbox(exitCode = 0, result = "ok\n") {
  const executeCommand = mock.fn(async (
    _command: string, _cwd?: string, _env?: Record<string, string>, _timeout?: number,
  ) => ({ exitCode, result, artifacts: { stdout: result } }));
  const uploadFile = mock.fn(async (_data: Buffer, _path: string, _timeout?: number) => {});
  const sandbox = {
    id: "test-sandbox", process: { executeCommand }, fs: { uploadFile },
  } as unknown as Sandbox;
  return { sandbox, executeCommand, uploadFile };
}

test("review sandbox persists without TTL or delete-on-stop and uses only a secret reference", async () => {
  await withoutEvents(async () => {
    const sandbox = fakeSandbox().sandbox;
    const create = mock.method(Daytona.prototype, "create", async () => sandbox);
    assert.equal(await createDemoSandbox(config), sandbox);
    const [params, options] = create.mock.calls[0]!.arguments;
    assert.equal(params?.ttlMinutes, 0);
    assert.equal(params?.autoStopInterval, 0);
    assert.equal(params?.autoDeleteInterval, -1);
    assert.equal(params?.user, "daytona");
    assert.equal(params?.public, false);
    assert.equal(params?.envVars, undefined);
    assert.deepEqual(params?.secrets, { BOX_ACCESS_TOKEN: "box-mount-token" });
    for (const credential of [config.boxAccessToken, config.openaiApiKey, config.daytonaApiKey]) {
      assert.ok(!JSON.stringify(params).includes(credential));
    }
    assert.equal(params?.labels?.reviewer, "openai");
    assert.deepEqual(options, { timeout: 180 });
  });
});

test("custom snapshots and TTLs reach Daytona but OpenAI credentials stay on the host", async () => {
  await withoutEvents(async () => {
    const create = mock.method(Daytona.prototype, "create", async () => fakeSandbox().sandbox);
    await createDemoSandbox({ ...config, daytonaSnapshot: "custom", openaiApiKey: "test-openai-key" }, 300_000);
    const params = create.mock.calls[0]!.arguments[0];
    assert.equal((params as { snapshot?: string })?.snapshot, "custom");
    assert.equal(params?.ttlMinutes, 5);
    assert.equal(params?.autoDeleteInterval, 0);
    assert.equal(params?.envVars, undefined);
    assert.deepEqual(params?.secrets, { BOX_ACCESS_TOKEN: "box-mount-token" });
    assert.equal(params?.labels?.reviewer, "openai");
  });
});

test("missing or inaccessible Secrets fail creation without a plaintext retry", async () => {
  await withoutEvents(async () => {
    const create = mock.method(Daytona.prototype, "create", async () => {
      throw new Error("secret unavailable");
    });
    await assert.rejects(createDemoSandbox(config), /secret unavailable/);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(create.mock.calls[0]!.arguments[0]?.envVars, undefined);
  });
});

test("reconnecting retrieves the saved ID without creating or extending a sandbox", async () => {
  await withoutEvents(async () => {
    const sandbox = fakeSandbox().sandbox;
    const get = mock.method(Daytona.prototype, "get", async () => sandbox);
    const create = mock.method(Daytona.prototype, "create", async () => { throw new Error("must not create"); });
    assert.equal(await connectSandbox("saved-id", config.daytonaApiKey), sandbox);
    assert.deepEqual(get.mock.calls[0]!.arguments, ["saved-id"]);
    assert.equal(create.mock.callCount(), 0);
  });
});

test("command adapter preserves shell syntax, cwd, output, and converts milliseconds to seconds", async () => {
  const { sandbox, executeCommand } = fakeSandbox();
  const command = "printf '%s' 'first' && printf '%s' 'second'";
  assert.deepEqual(await runCommand(sandbox, command, { cwd: "/home/daytona", timeoutMs: 30_001 }), { stdout: "ok\n" });
  const [wrapped, cwd, env, timeout] = executeCommand.mock.calls[0]!.arguments;
  assert.equal(execFileSync("sh", ["-c", wrapped!], { encoding: "utf8" }), "firstsecond");
  assert.equal(cwd, "/home/daytona");
  assert.equal(env, undefined);
  assert.equal(timeout, 31);
});

test("nonzero command exits fail the workflow with the returned diagnostics", async () => {
  await assert.rejects(runCommand(fakeSandbox(7, "mount failed").sandbox, "box-mount mount"), /exit 7.*\nmount failed/);
});

test("shell arguments containing quotes and substitutions remain literal", () => {
  const value = "path with 'quotes'; $(printf injected) `printf injected`\nnext";
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }), value);
});

test("text uploads are UTF-8 buffers and binary uploads preserve every byte", async () => {
  const { sandbox, uploadFile } = fakeSandbox();
  await writeSandboxFile(sandbox, "/tmp/review.md", "Review — café", 180_000);
  const binary = Buffer.from([0, 255, 128, 13, 10]);
  await writeSandboxFile(sandbox, "/tmp/contract.docx", binary);
  const [text, path, timeout] = uploadFile.mock.calls[0]!.arguments;
  assert.ok(Buffer.isBuffer(text));
  assert.equal(text.toString("utf8"), "Review — café");
  assert.equal(path, "/tmp/review.md");
  assert.equal(timeout, 180);
  assert.deepEqual(uploadFile.mock.calls[1]!.arguments[0], binary);
});

test("seeding uploads the original DOCX unchanged to the Daytona workspace", async () => {
  const { sandbox, uploadFile } = fakeSandbox();
  const root = new URL("../fixtures/box-workspace/", import.meta.url).pathname;
  const uploaded = await uploadFixtures(sandbox, root);
  assert.equal(uploaded.length, 2);
  const docx = uploadFile.mock.calls.find(call => call.arguments[1]?.endsWith("Acme-MSA.docx"))!;
  assert.equal(docx.arguments[1], `${REMOTE_MOUNT_PATH}/Incoming/Acme-MSA.docx`);
  assert.deepEqual(docx.arguments[0], await readFile(`${root}/Incoming/Acme-MSA.docx`));
});

test("SandboxAgent uses Daytona shell tools and saves its final memo to the existing mount", async () => {
  const log = mock.method(console, "log", () => {});
  const model = new ScriptedModel([
    [functionCall("exec_command", { cmd: "cat Playbook/approved-contract-playbook.md" }, { callId: "read-playbook" })],
    [functionCall("exec_command", { cmd: "unzip -p Incoming/Acme-MSA.docx word/document.xml" }, { callId: "read-contract" })],
    [assistantMessage("# Review\nSection 4 differs from the playbook.")],
  ]);
  const getModel = mock.method(OpenAIProvider.prototype, "getModel", async () => model);
  const close = mock.method(OpenAIProvider.prototype, "close", async () => {});
  const { sandbox, executeCommand, uploadFile } = fakeSandbox(0, "document contents\n");
  assert.equal(await runContractAgent(sandbox, { ...config, openaiApiKey: "test-openai-key" }), REVIEW_OUTPUT_PATH);
  model.assertComplete();
  assert.equal(getModel.mock.calls[0]!.arguments[0], "test-model");
  assert.equal(close.mock.callCount(), 1);
  assert.equal(model.calls.length, 3);
  assert.match(JSON.stringify(model.calls[1]!.request.input), /document contents/);
  assert.equal(model.firstCall?.request.tracing, false);
  assert.equal(executeCommand.mock.calls.length, 3);
  const command = executeCommand.mock.calls[0]!.arguments;
  assert.match(command[0], /cat Playbook/);
  assert.equal(command[1], REMOTE_MOUNT_PATH);
  assert.equal(command[3], 60);
  assert.equal(uploadFile.mock.calls.length, 1);
  const [content, path] = uploadFile.mock.calls[0]!.arguments;
  assert.equal(path, REVIEW_OUTPUT_PATH);
  assert.match(content.toString(), /^# Review\nSection 4/);
  assert.match(content.toString(), /Qualified legal review is required/);
  const logs = log.mock.calls.map(call => call.arguments.join(" ")).join("\n");
  assert.match(logs, /\[tool\] exec_command started: .*cat Playbook/);
  assert.match(logs, /\[tool\] exec_command returned \(exit 0\)/);
  assert.doesNotMatch(logs, /document contents|Section 4 differs/);
});

test("tool logs redact configured credentials, escape commands, and report failed exits without output", async () => {
  const log = mock.method(console, "log", () => {});
  const model = new ScriptedModel([
    [functionCall("exec_command", {
      cmd: "echo test-openai-key test-daytona-key test-box-token\n\u001b[31m",
    }, { callId: "logged-call" })],
    [assistantMessage("# Review")],
  ]);
  mock.method(OpenAIProvider.prototype, "getModel", async () => model);
  const { sandbox, executeCommand } = fakeSandbox();
  executeCommand.mock.mockImplementationOnce(async () => ({
    exitCode: 7, result: "private document contents", artifacts: { stdout: "private document contents" },
  }));
  await runContractAgent(sandbox, { ...config, openaiApiKey: "test-openai-key" });
  const logs = log.mock.calls.map(call => call.arguments.join(" ")).join("\n");
  assert.match(logs, /\[REDACTED\] \[REDACTED\] \[REDACTED\]/);
  assert.match(logs, /\\n\\u001b\[31m/);
  assert.match(logs, /returned \(exit 7\)/);
  assert.doesNotMatch(logs, /test-openai-key|test-daytona-key|test-box-token|private document contents|\u001b/);
});

test("review output directory errors stop before uploading the memo", async () => {
  const model = new ScriptedModel([[assistantMessage("# Review")]]);
  mock.method(OpenAIProvider.prototype, "getModel", async () => model);
  const { sandbox, uploadFile } = fakeSandbox(1, "permission denied");
  await assert.rejects(runContractAgent(sandbox, { ...config, openaiApiKey: "test-openai-key" }), /permission denied/);
  assert.equal(uploadFile.mock.callCount(), 0);
});

test("empty OpenAI output and model failures never overwrite a review", async () => {
  const model = new ScriptedModel([
    [assistantMessage("   ")],
    modelError(new Error("model unavailable")),
  ]);
  mock.method(OpenAIProvider.prototype, "getModel", async () => model);
  const close = mock.method(OpenAIProvider.prototype, "close", async () => {});
  const { sandbox, executeCommand, uploadFile } = fakeSandbox();
  const openaiConfig = { ...config, openaiApiKey: "test-openai-key" };
  await assert.rejects(runContractAgent(sandbox, openaiConfig), /no review text/);
  await assert.rejects(runContractAgent(sandbox, openaiConfig), /model unavailable/);
  assert.equal(executeCommand.mock.callCount(), 0);
  assert.equal(uploadFile.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 2);
});

test("a looping agent stops at the turn limit without publishing a partial review", async () => {
  mock.method(console, "log", () => {});
  const model = new ScriptedModel(Array.from({ length: 21 }, (_, index) => [
    functionCall("exec_command", { cmd: "pwd" }, { callId: `loop-${index}` }),
  ]));
  mock.method(OpenAIProvider.prototype, "getModel", async () => model);
  const close = mock.method(OpenAIProvider.prototype, "close", async () => {});
  const { sandbox, uploadFile } = fakeSandbox();
  await assert.rejects(
    runContractAgent(sandbox, { ...config, openaiApiKey: "test-openai-key" }),
    { name: "MaxTurnsExceededError" },
  );
  assert.equal(model.calls.length, 20);
  assert.equal(uploadFile.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
});

test("configuration rejects missing, empty, and whitespace-only OpenAI keys", () => {
  const names = ["DAYTONA_API_KEY", "BOX_ACCESS_TOKEN", "BOX_FOLDER_ID", "OPENAI_API_KEY"];
  const previous = names.map(name => process.env[name]);
  try {
    process.env.DAYTONA_API_KEY = config.daytonaApiKey;
    process.env.BOX_ACCESS_TOKEN = config.boxAccessToken;
    process.env.BOX_FOLDER_ID = config.boxFolderId;
    for (const value of [undefined, "", " \n\t "]) {
      if (value === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = value;
      assert.throws(() => getDemoConfig(), /Missing OPENAI_API_KEY/);
    }
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});

test("the agent rejects blank keys before model calls or sandbox operations", async () => {
  const getModel = mock.method(OpenAIProvider.prototype, "getModel", async () => {
    throw new Error("must not call a model without an API key");
  });
  const { sandbox, executeCommand, uploadFile } = fakeSandbox();
  for (const openaiApiKey of ["", " \n\t "]) {
    await assert.rejects(runContractAgent(sandbox, { ...config, openaiApiKey }), /Missing OPENAI_API_KEY/);
  }
  assert.equal(getModel.mock.callCount(), 0);
  assert.equal(executeCommand.mock.callCount(), 0);
  assert.equal(uploadFile.mock.callCount(), 0);
});

test("agent session preserves command semantics and reports nonzero exits for recovery", async () => {
  const { sandbox, executeCommand } = fakeSandbox(7, "file not found");
  const session = createAgentSandboxSession(sandbox);
  const cmd = "printf '%s' 'first' && printf '%s' 'second'";
  assert.equal(await session.execCommand!({ cmd, workdir: "Incoming", login: false }), "Exit code: 7\nfile not found");
  const [wrapped, cwd, env, timeout] = executeCommand.mock.calls[0]!.arguments;
  assert.equal(execFileSync("sh", ["-c", wrapped], { encoding: "utf8" }), "firstsecond");
  assert.equal(cwd, `${REMOTE_MOUNT_PATH}/Incoming`);
  assert.equal(env, undefined);
  assert.equal(timeout, 60);
  assert.equal(session.state.manifest.root, REMOTE_MOUNT_PATH);
  assert.equal(session.supportsPty?.(), false);
  assert.equal(session.close, undefined);
  assert.equal(session.delete, undefined);
});

test("agent session bounds output and rejects unsupported interactive or user-switching requests", async () => {
  const { sandbox, executeCommand } = fakeSandbox(0, "abcdefghij");
  const session = createAgentSandboxSession(sandbox);
  assert.match(await session.execCommand!({ cmd: "echo test", maxOutputTokens: 1 }), /abcd\n\[Output truncated/);
  for (const options of [{ tty: true }, { runAs: "root" }, { shell: "/bin/zsh" }]) {
    await assert.rejects(session.execCommand!({ cmd: "echo test", ...options }));
  }
  assert.equal(executeCommand.mock.callCount(), 1);
});

test("deletion waits for completion and propagates errors so local state can be retained", async () => {
  const deletion = mock.fn(async (_timeout?: number, _wait?: boolean) => {});
  await destroySandbox({ delete: deletion } as unknown as Sandbox);
  assert.deepEqual(deletion.mock.calls[0]!.arguments, [60, true]);
  await assert.rejects(destroySandbox({ delete: async () => { throw new Error("service unavailable"); } } as unknown as Sandbox), /service unavailable/);
});

test("a sandbox already deleted by the TTL counts as successful cleanup", async () => {
  await destroySandbox({ delete: async () => { throw new DaytonaNotFoundError("expired"); } } as unknown as Sandbox);
});
