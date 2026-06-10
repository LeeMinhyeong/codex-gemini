#!/usr/bin/env node

const path = require("node:path");
const { runGemini } = require("../../plugins/codex-gemini/scripts/gemini-bridge.js");

const fakeGemini = path.join(__dirname, "fake-gemini.js");

runGemini(process.execPath, [fakeGemini], {
  input: "heartbeat-test",
  timeoutMs: 150,
  heartbeatMs: 25,
  promptBytes: 14,
  env: { ...process.env, FAKE_GEMINI_MODE: "hang" },
}).then((result) => {
  process.stdout.write(`${JSON.stringify(result.termination)}\n`);
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
