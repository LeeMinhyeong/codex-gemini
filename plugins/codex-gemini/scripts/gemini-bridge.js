#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 32768;
const DEFAULT_WARN_PROMPT_BYTES = 32768;
const DEFAULT_TIMEOUT_MS = 0;
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const SNIPPET_CHARS = 2000;
const STDIN_PROMPT_INSTRUCTION = "Use the prompt provided on stdin and answer it.";
const SUPPORTED_FORMATS = new Set(["text", "json", "stream-json"]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".svgz",
  ".tar",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".env.development",
  ".env.development.local",
  ".env.local",
  ".env.production",
  ".env.production.local",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "authorized_keys",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".crt",
  ".der",
  ".jks",
  ".kdbx",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
]);

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".gnupg",
  ".gcloud",
  ".kube",
  ".ssh",
]);

const SENSITIVE_NAME_PATTERNS = [
  /^\.env\./i,
  /credential/i,
  /private[-_]?key/i,
  /service[-_]?account/i,
  /secret/i,
];

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const MEDIA_TYPES = new Map([
  [".csv", "text/csv"],
  [".graphql", "application/graphql"],
  [".gql", "application/graphql"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".md", "text/markdown"],
  [".sql", "text/sql"],
  [".toml", "application/toml"],
  [".tsv", "text/tab-separated-values"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

const USAGE = `Usage: node scripts/gemini-bridge.js [options] <task>

Options:
  --task <text>            Explicit task text.
  --model <name>           Gemini model override.
  --dirs <path,...>        Directories to ingest recursively.
  --files <glob,...>       File globs to ingest.
  --format <format>        text, json, or stream-json. Default: text.
  --max-files <n>          Maximum files to inline. Default: ${DEFAULT_MAX_FILES}.
  --max-file-bytes <n>     Maximum bytes per file. Default: ${DEFAULT_MAX_FILE_BYTES}.
  --timeout-ms <n>         Kill Gemini if it runs longer than n ms. 0 disables. Default: ${DEFAULT_TIMEOUT_MS}.
  --warn-prompt-bytes <n>  Warn when the prompt reaches n bytes. 0 disables. Default: ${DEFAULT_WARN_PROMPT_BYTES}.
  --fail-on-prompt-bytes <n>
                           Fail before calling Gemini when the prompt exceeds n bytes.
  --print-prompt-size      Print the prompt byte size before calling Gemini.
  --output-file <path>     Write Gemini stdout to a workspace-local file.
  --print-command          Print the resolved Gemini command and exit.
  -h, --help               Show this help.

Security:
  The bridge skips common secret files such as .env files, SSH keys,
  certificates, credentials, and service account files.
`;

function splitList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSlashes(value) {
  return value.split(path.sep).join("/");
}

function relativeToCwd(cwd, targetPath) {
  return normalizeSlashes(path.relative(cwd, targetPath));
}

function isInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getMediaType(filePath) {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) || "text/plain";
}

function isIgnoredPath(relativePath) {
  return relativePath.split("/").some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function isSensitivePath(relativePath) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) {
    return true;
  }

  const fileName = segments[segments.length - 1] || "";
  const lowerFileName = fileName.toLowerCase();
  const extension = path.extname(lowerFileName);

  if (SENSITIVE_FILE_NAMES.has(lowerFileName) || SENSITIVE_EXTENSIONS.has(extension)) {
    return true;
  }

  return SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(fileName));
}

function isBinaryCandidate(filePath, buffer) {
  if (KNOWN_BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }
  return buffer.includes(0);
}

function parsePositiveInteger(rawValue, flagName) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer. Received: ${rawValue}`);
  }
  return value;
}

function parseNonNegativeInteger(rawValue, flagName) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flagName} must be a non-negative integer. Received: ${rawValue}`);
  }
  return value;
}

function takeOptionValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}.`);
  }
  return value;
}

function parseCliArgs(argv) {
  const parsed = {
    model: undefined,
    dirs: [],
    files: [],
    format: "text",
    maxFiles: DEFAULT_MAX_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    warnPromptBytes: DEFAULT_WARN_PROMPT_BYTES,
    failOnPromptBytes: undefined,
    printPromptSize: false,
    outputFile: undefined,
    printCommand: false,
    task: "",
    help: false,
  };
  const taskTokens = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      taskTokens.push(...argv.slice(index + 1));
      break;
    }

    switch (token) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--task":
        parsed.task = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--model":
        parsed.model = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--dirs":
        parsed.dirs.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--files":
        parsed.files.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--format": {
        const format = takeOptionValue(argv, index, token);
        if (!SUPPORTED_FORMATS.has(format)) {
          throw new Error(`Unsupported --format value "${format}". Expected text, json, or stream-json.`);
        }
        parsed.format = format;
        index += 1;
        break;
      }
      case "--max-files":
        parsed.maxFiles = parsePositiveInteger(takeOptionValue(argv, index, token), token);
        index += 1;
        break;
      case "--max-file-bytes":
        parsed.maxFileBytes = parsePositiveInteger(takeOptionValue(argv, index, token), token);
        index += 1;
        break;
      case "--timeout-ms":
        parsed.timeoutMs = parseNonNegativeInteger(takeOptionValue(argv, index, token), token);
        index += 1;
        break;
      case "--warn-prompt-bytes":
        parsed.warnPromptBytes = parseNonNegativeInteger(takeOptionValue(argv, index, token), token);
        index += 1;
        break;
      case "--fail-on-prompt-bytes":
        parsed.failOnPromptBytes = parseNonNegativeInteger(takeOptionValue(argv, index, token), token);
        index += 1;
        break;
      case "--print-prompt-size":
        parsed.printPromptSize = true;
        break;
      case "--output-file":
        parsed.outputFile = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--print-command":
        parsed.printCommand = true;
        break;
      default:
        taskTokens.push(token);
        break;
    }
  }

  if (!parsed.task) {
    parsed.task = taskTokens.join(" ").trim();
  }
  if (!parsed.help && !parsed.task) {
    throw new Error(`A task is required.\n\n${USAGE}`);
  }
  return parsed;
}

function walkFiles(root, skipped, cwd) {
  const files = [];

  function visit(current) {
    const relativePath = relativeToCwd(cwd, current);
    if (relativePath && isIgnoredPath(relativePath)) {
      skipped.push({ path: relativePath, reason: "ignored-path" });
      return;
    }
    if (relativePath && isSensitivePath(relativePath)) {
      skipped.push({ path: relativePath, reason: "sensitive-path" });
      return;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: relativePath || ".", reason: `read-error: ${error.message}` });
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  visit(root);
  return files;
}

function escapeRegexChar(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegex(pattern) {
  const normalized = normalizeSlashes(pattern);
  let source = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterGlobstar = normalized[index + 2];
        if (afterGlobstar === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexChar(char);
    }
  }

  source += "$";
  return new RegExp(source);
}

function collectDirectoryMatches(cwd, dirPath, skipped) {
  const workspaceRoot = path.resolve(cwd);
  const absolutePath = path.resolve(cwd, dirPath);
  const relativePath = relativeToCwd(cwd, absolutePath);

  if (!isInside(workspaceRoot, absolutePath)) {
    skipped.push({ path: dirPath, reason: "outside-workspace" });
    return [];
  }
  if (!fs.existsSync(absolutePath)) {
    skipped.push({ path: dirPath, reason: "not-found" });
    return [];
  }
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    return [absolutePath];
  }
  if (!stat.isDirectory()) {
    skipped.push({ path: relativePath, reason: "not-a-directory" });
    return [];
  }
  return walkFiles(absolutePath, skipped, cwd);
}

function collectPatternMatches(cwd, patterns, skipped) {
  if (patterns.length === 0) {
    return [];
  }
  const workspaceRoot = path.resolve(cwd);
  const allFiles = walkFiles(workspaceRoot, skipped, cwd);
  const regexes = patterns.map(globToRegex);
  return allFiles.filter((filePath) => {
    const relativePath = relativeToCwd(cwd, filePath);
    return regexes.some((regex) => regex.test(relativePath));
  });
}

function collectContextFiles({ cwd, dirs, patterns, maxFiles, maxFileBytes }) {
  const workspaceRoot = path.resolve(cwd);
  const allMatches = new Set();
  const skipped = [];

  for (const dirPath of dirs) {
    for (const match of collectDirectoryMatches(cwd, dirPath, skipped)) {
      allMatches.add(path.resolve(match));
    }
  }

  for (const match of collectPatternMatches(cwd, patterns, skipped)) {
    allMatches.add(path.resolve(match));
  }

  const included = [];
  const sortedMatches = [...allMatches].sort((left, right) => left.localeCompare(right));

  for (const absolutePath of sortedMatches) {
    const relativePath = relativeToCwd(cwd, absolutePath);
    if (!isInside(workspaceRoot, absolutePath)) {
      skipped.push({ path: relativePath, reason: "outside-workspace" });
      continue;
    }
    if (isIgnoredPath(relativePath)) {
      skipped.push({ path: relativePath, reason: "ignored-path" });
      continue;
    }
    if (isSensitivePath(relativePath)) {
      skipped.push({ path: relativePath, reason: "sensitive-path" });
      continue;
    }
    if (included.length >= maxFiles) {
      skipped.push({ path: relativePath, reason: "max-files-exceeded" });
      continue;
    }

    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        skipped.push({ path: relativePath, reason: "not-a-file" });
        continue;
      }
      const fileBuffer = fs.readFileSync(absolutePath);
      if (isBinaryCandidate(absolutePath, fileBuffer)) {
        skipped.push({ path: relativePath, reason: "unsupported-binary" });
        continue;
      }

      const truncated = fileBuffer.length > maxFileBytes;
      const trimmedBuffer = truncated ? fileBuffer.subarray(0, maxFileBytes) : fileBuffer;
      included.push({
        path: relativePath,
        mediaType: getMediaType(absolutePath),
        bytes: fileBuffer.length,
        truncated,
        content: trimmedBuffer.toString("utf8"),
      });
    } catch (error) {
      skipped.push({ path: relativePath, reason: `read-error: ${error.message}` });
    }
  }

  return { included, skipped };
}

function buildGeminiPrompt({ task, context, cwd }) {
  const inventoryLines = [`Workspace root: ${cwd}`];

  if (context.included.length > 0) {
    inventoryLines.push("Included files:");
    for (const file of context.included) {
      inventoryLines.push(
        `- ${file.path} | ${file.mediaType} | ${file.bytes} bytes | truncated=${file.truncated}`,
      );
    }
  } else {
    inventoryLines.push("Included files: none");
  }

  if (context.skipped.length > 0) {
    inventoryLines.push("Skipped files:");
    for (const skipped of context.skipped) {
      inventoryLines.push(`- ${skipped.path} (${skipped.reason})`);
    }
  }

  const fileBlocks =
    context.included.length === 0
      ? "No inline file payloads were collected."
      : context.included
          .map(
            (file) =>
              `<file path="${file.path}" media_type="${file.mediaType}" bytes="${file.bytes}" truncated="${file.truncated}">\n${file.content}\n</file>`,
          )
          .join("\n\n");

  return [
    "You are Gemini assisting Codex with a large-context code or data analysis pass.",
    "",
    "Context inventory:",
    inventoryLines.join("\n"),
    "",
    "Inline context:",
    fileBlocks,
    "",
    "Task:",
    task,
    "",
    "Instructions:",
    "- Use the provided workspace context when it is relevant.",
    "- Cite file paths when referring to evidence from inline context.",
    "- Call out when context is partial, skipped, or truncated.",
    "- Separate direct evidence from inference.",
    "- Do not invent files, APIs, or data that are not present in the provided payloads.",
  ].join("\n");
}

function buildGeminiArgs({ model, format }) {
  const args = ["-p", STDIN_PROMPT_INSTRUCTION];
  if (model) {
    args.push("-m", model);
  }
  args.push("--output-format", format);
  return args;
}

function resolveGeminiInvocation() {
  if (process.platform !== "win32") {
    return { command: "gemini", prefixArgs: [] };
  }

  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const names = ["gemini.cmd", "gemini.exe", "gemini.bat", "gemini"];

  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (fs.existsSync(candidate)) {
        const bundledEntrypoint = path.join(
          entry,
          "node_modules",
          "@google",
          "gemini-cli",
          "bundle",
          "gemini.js",
        );
        if (fs.existsSync(bundledEntrypoint)) {
          return { command: process.execPath, prefixArgs: [bundledEntrypoint] };
        }
        return { command: candidate, prefixArgs: [] };
      }
    }
  }

  return { command: "gemini", prefixArgs: [] };
}

function printResolvedCommand(command, args, stdinText) {
  const rendered = [command, ...args.map((arg) => JSON.stringify(arg))].join(" ");
  process.stdout.write(`${rendered}\n`);
  process.stdout.write(`[stdin: ${Buffer.byteLength(stdinText, "utf8")} bytes]\n`);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function promptSizeAdvice() {
  return [
    "Try narrowing --dirs/--files, lowering --max-files or --max-file-bytes,",
    "splitting the review into smaller passes, or increasing --timeout-ms.",
  ].join(" ");
}

function outputSnippet(label, text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  const snippet =
    trimmed.length > SNIPPET_CHARS ? trimmed.slice(trimmed.length - SNIPPET_CHARS) : trimmed;
  return `\n${label} tail:\n${snippet}\n`;
}

function resolveOutputFile(cwd, outputFile) {
  if (!outputFile) {
    return undefined;
  }
  const workspaceRoot = path.resolve(cwd);
  const absolutePath = path.resolve(cwd, outputFile);
  if (!isInside(workspaceRoot, absolutePath)) {
    throw new Error("--output-file must stay inside the current workspace.");
  }
  return absolutePath;
}

function writePromptDiagnostics({ promptBytes, warnPromptBytes, printPromptSize }) {
  if (printPromptSize) {
    process.stderr.write(`[gemini-bridge] Prompt size: ${formatBytes(promptBytes)} (${promptBytes} bytes)\n`);
  }
  if (warnPromptBytes > 0 && promptBytes >= warnPromptBytes) {
    process.stderr.write(
      `[gemini-bridge] Large prompt: ${formatBytes(promptBytes)} (${promptBytes} bytes). ${promptSizeAdvice()}\n`,
    );
  }
}

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }

    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const finish = () => {
        try {
          child.kill();
        } catch {
          // The process may already be gone.
        }
        resolve();
      };
      killer.once("error", finish);
      killer.once("close", finish);
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }

    const forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be gone.
      }
      resolve();
    }, 1500);

    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
}

function runGemini(command, args, { input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const clearTimer = timeoutMs > 0 ? setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child);
    }, timeoutMs) : undefined;

    function capture(chunks, currentBytes, chunk) {
      chunks.push(chunk);
      return currentBytes + chunk.length;
    }

    function checkCaptureLimit() {
      if (!outputExceeded && stdoutBytes + stderrBytes > MAX_CAPTURE_BYTES) {
        outputExceeded = true;
        killProcessTree(child).catch(() => {});
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes = capture(stdoutChunks, stdoutBytes, chunk);
      checkCaptureLimit();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = capture(stderrChunks, stderrBytes, chunk);
      checkCaptureLimit();
    });
    child.once("error", (error) => {
      if (clearTimer) {
        clearTimeout(clearTimer);
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (status, signal) => {
      if (clearTimer) {
        clearTimeout(clearTimer);
      }
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        status: status === null ? 1 : status,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        outputExceeded,
      });
    });

    child.stdin.on("error", () => {
      // Gemini may close stdin early on fast failures; the process result carries the error details.
    });
    child.stdin.end(input);
  });
}

function writeOutput(cwd, outputFilePath, stdout) {
  if (!outputFilePath) {
    if (stdout) {
      process.stdout.write(stdout);
    }
    return;
  }

  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, stdout || "", "utf8");
  process.stderr.write(
    `[gemini-bridge] Wrote Gemini stdout to ${relativeToCwd(cwd, outputFilePath)}\n`,
  );
}

async function run(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const cwd = process.cwd();
  const context = collectContextFiles({
    cwd,
    dirs: parsed.dirs,
    patterns: parsed.files,
    maxFiles: parsed.maxFiles,
    maxFileBytes: parsed.maxFileBytes,
  });
  const prompt = buildGeminiPrompt({ task: parsed.task, context, cwd });
  const geminiArgs = buildGeminiArgs({
    model: parsed.model,
    format: parsed.format,
  });
  const geminiInvocation = resolveGeminiInvocation();
  const commandArgs = [...geminiInvocation.prefixArgs, ...geminiArgs];
  const promptBytes = Buffer.byteLength(prompt, "utf8");

  if (parsed.printCommand) {
    printResolvedCommand(geminiInvocation.command, commandArgs, prompt);
    return 0;
  }

  const outputFilePath = resolveOutputFile(cwd, parsed.outputFile);

  if (parsed.failOnPromptBytes > 0 && promptBytes > parsed.failOnPromptBytes) {
    throw new Error(
      `Prompt size ${formatBytes(promptBytes)} (${promptBytes} bytes) exceeds --fail-on-prompt-bytes ${parsed.failOnPromptBytes}. ${promptSizeAdvice()}`,
    );
  }

  writePromptDiagnostics({
    promptBytes,
    warnPromptBytes: parsed.warnPromptBytes,
    printPromptSize: parsed.printPromptSize,
  });

  const result = await runGemini(geminiInvocation.command, commandArgs, {
    input: prompt,
    timeoutMs: parsed.timeoutMs,
  });

  if (result.timedOut) {
    process.stderr.write(
      [
        `[gemini-bridge] Gemini timed out after ${parsed.timeoutMs} ms.`,
        `Prompt size: ${formatBytes(promptBytes)} (${promptBytes} bytes).`,
        promptSizeAdvice(),
        outputSnippet("stdout", result.stdout),
        outputSnippet("stderr", result.stderr),
      ].join("\n") + "\n",
    );
    return 124;
  }

  if (result.outputExceeded) {
    process.stderr.write(
      `[gemini-bridge] Gemini output exceeded ${formatBytes(MAX_CAPTURE_BYTES)}. Narrow the request or ask for a shorter response.\n`,
    );
    return 1;
  }

  writeOutput(cwd, outputFilePath, result.stdout);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    process.stderr.write(
      `[gemini-bridge] Gemini exited with status ${result.status}. Prompt size: ${formatBytes(promptBytes)} (${promptBytes} bytes).\n`,
    );
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    if (error.code === "ENOENT") {
      process.stderr.write(
        "Gemini CLI is not installed or not on PATH. Install it with `npm install -g @google/gemini-cli`, then run `gemini auth`.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
