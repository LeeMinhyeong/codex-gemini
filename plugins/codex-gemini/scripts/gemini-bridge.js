#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 32768;
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

function buildGeminiArgs({ prompt, model, format }) {
  const args = ["-p", prompt];
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

function printResolvedCommand(command, args) {
  const rendered = [command, ...args.map((arg) => JSON.stringify(arg))].join(" ");
  process.stdout.write(`${rendered}\n`);
}

function run(argv) {
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
    prompt,
    model: parsed.model,
    format: parsed.format,
  });
  const geminiInvocation = resolveGeminiInvocation();
  const commandArgs = [...geminiInvocation.prefixArgs, ...geminiArgs];

  if (parsed.printCommand) {
    printResolvedCommand(geminiInvocation.command, commandArgs);
    return 0;
  }

  const result = spawnSync(geminiInvocation.command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(
        "Gemini CLI is not installed or not on PATH. Install it with `npm install -g @google/gemini-cli`, then run `gemini auth`.",
      );
    }
    throw result.error;
  }

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
