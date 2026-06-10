#!/usr/bin/env node

const { spawn } = require("node:child_process");

const POLL_MS = 1000;

function parsePid(rawValue, label) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive process ID.`);
  }
  return value;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

async function main(argv) {
  const bridgePid = parsePid(argv[0], "bridge PID");
  const geminiPid = parsePid(argv[1], "Gemini PID");
  let stopping = false;
  let cleaning = false;

  async function cleanOrphan() {
    if (stopping || cleaning || !isProcessAlive(geminiPid)) {
      process.exit(0);
      return;
    }
    cleaning = true;
    await killProcessTree(geminiPid);
    process.exit(0);
  }

  process.on("message", (message) => {
    if (message?.type === "stop") {
      stopping = true;
      process.exit(0);
    }
  });
  process.on("disconnect", () => {
    cleanOrphan().catch(() => process.exit(1));
  });

  const pollTimer = setInterval(() => {
    if (!isProcessAlive(geminiPid)) {
      process.exit(0);
      return;
    }
    if (!isProcessAlive(bridgePid)) {
      cleanOrphan().catch(() => process.exit(1));
    }
  }, POLL_MS);

  process.once("exit", () => clearInterval(pollTimer));
  if (process.send) {
    process.send({ type: "ready" });
  }
}

main(process.argv.slice(2)).catch(() => {
  process.exitCode = 1;
});
