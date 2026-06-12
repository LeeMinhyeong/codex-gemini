const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runGemini } = require("../plugins/codex-gemini/scripts/gemini-bridge.js");

const fakeGemini = path.join(__dirname, "fixtures", "fake-gemini.js");
const heartbeatRunner = path.join(__dirname, "fixtures", "heartbeat-runner.js");
const signalRunner = path.join(__dirname, "fixtures", "signal-runner.js");
const watchdogRunner = path.join(__dirname, "fixtures", "watchdog-runner.js");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

test("runGemini returns normal output", { concurrency: false }, async () => {
  const result = await runGemini(process.execPath, [fakeGemini], {
    input: "hello",
    timeoutMs: 5000,
    heartbeatMs: 0,
    promptBytes: 5,
    env: { ...process.env, FAKE_GEMINI_MODE: "success" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.termination, undefined);
  assert.match(result.stdout, /FAKE_GEMINI_OK:hello/);
});

test("runGemini stops a timed-out process tree", { concurrency: false }, async () => {
  const result = await runGemini(process.execPath, [fakeGemini], {
    input: "timeout",
    timeoutMs: 100,
    heartbeatMs: 0,
    promptBytes: 7,
    env: { ...process.env, FAKE_GEMINI_MODE: "hang" },
  });

  assert.equal(result.termination?.type, "timeout");
});

test("runGemini turns output write failures into supervised termination", { concurrency: false }, async () => {
  const result = await runGemini(process.execPath, [fakeGemini], {
    input: "write-error",
    timeoutMs: 5000,
    heartbeatMs: 0,
    promptBytes: 11,
    captureStdout: false,
    onStdout() {
      throw new Error("disk unavailable");
    },
    env: { ...process.env, FAKE_GEMINI_MODE: "success" },
  });

  assert.equal(result.termination?.type, "output-write-error");
  assert.equal(result.outputWriteError, "disk unavailable");
});

test("runGemini forwards an interrupt into the shared cleanup path", { concurrency: false }, () => {
  const result = spawnSync(process.execPath, [signalRunner], {
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { type: "signal", signal: "SIGINT" });
  assert.match(result.stderr, /Received SIGINT; stopping Gemini/);
});

test("runGemini emits heartbeat progress on stderr", { concurrency: false }, () => {
  const result = spawnSync(process.execPath, [heartbeatRunner], {
    encoding: "utf8",
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { type: "timeout" });
  assert.match(result.stderr, /Gemini still running: elapsed=/);
  assert.match(result.stderr, /prompt=14 B/);
});

test(
  "Windows watchdog stops Gemini when the bridge is force-killed",
  { concurrency: false, skip: process.platform !== "win32", timeout: 10000 },
  async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gemini-watchdog-"));
    const pidFile = path.join(tempDir, "gemini.pid");
    const runner = spawn(process.execPath, [watchdogRunner], {
      env: { ...process.env, FAKE_GEMINI_PID_FILE: pidFile },
      stdio: "ignore",
      windowsHide: true,
    });

    let geminiPid;
    try {
      await waitFor(() => fs.existsSync(pidFile));
      geminiPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
      assert.equal(isProcessAlive(geminiPid), true);

      const killed = spawnSync("taskkill", ["/PID", String(runner.pid), "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(killed.status, 0, killed.stderr || killed.stdout);
      await waitFor(() => !isProcessAlive(geminiPid));
      assert.equal(isProcessAlive(geminiPid), false);
    } finally {
      if (geminiPid && isProcessAlive(geminiPid)) {
        spawnSync("taskkill", ["/PID", String(geminiPid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
      if (isProcessAlive(runner.pid)) {
        spawnSync("taskkill", ["/PID", String(runner.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);
