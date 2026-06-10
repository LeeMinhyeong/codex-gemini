#!/usr/bin/env node

const path = require("node:path");
const { runGemini } = require("../../plugins/codex-gemini/scripts/gemini-bridge.js");

const fakeGemini = path.join(__dirname, "fake-gemini.js");

runGemini(process.execPath, [fakeGemini], {
  input: "watchdog-test",
  timeoutMs: 0,
  heartbeatMs: 0,
  promptBytes: 13,
  env: {
    ...process.env,
    FAKE_GEMINI_MODE: "hang",
    FAKE_GEMINI_PID_FILE: process.env.FAKE_GEMINI_PID_FILE,
  },
}).then(() => {
  process.exitCode = 0;
}).catch(() => {
  process.exitCode = 1;
});
