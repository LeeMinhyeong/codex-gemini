#!/usr/bin/env node

const path = require("node:path");
const { runGemini } = require("../../plugins/codex-gemini/scripts/gemini-bridge.js");

const fakeGemini = path.join(__dirname, "fake-gemini.js");
setTimeout(() => process.emit("SIGINT"), 100);

runGemini(process.execPath, [fakeGemini], {
  input: "signal-test",
  timeoutMs: 0,
  heartbeatMs: 0,
  promptBytes: 11,
  env: { ...process.env, FAKE_GEMINI_MODE: "hang" },
}).then((result) => {
  process.stdout.write(`${JSON.stringify(result.termination)}\n`);
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
