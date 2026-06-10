#!/usr/bin/env node

const fs = require("node:fs");

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  if (process.env.FAKE_GEMINI_PID_FILE) {
    fs.writeFileSync(process.env.FAKE_GEMINI_PID_FILE, String(process.pid), "utf8");
  }

  if (process.env.FAKE_GEMINI_MODE === "hang") {
    setInterval(() => {}, 1000);
    return;
  }

  process.stdout.write(`FAKE_GEMINI_OK:${Buffer.concat(chunks).toString("utf8")}\n`);
});
