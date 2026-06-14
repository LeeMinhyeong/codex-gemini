# Codex Gemini

Codex Gemini is a Codex plugin that delegates broad codebase analysis and review tasks to the local Gemini CLI.

`1.0.0-rc.3` adds deterministic JSON Schema and closed-scope output validation while preserving Gemini's raw output.

Use it when a task benefits from a large-context pass over many files, such as architecture review, refactor impact analysis, security review, documentation synthesis, or structured data analysis.

This is not an official OpenAI or Google plugin.

## Requirements

- Codex with plugin support
- Node.js 20 or newer available on `PATH`
- Gemini CLI installed and authenticated

Install Gemini CLI:

```powershell
npm install -g @google/gemini-cli
gemini auth
```

On Windows, this plugin invokes the Gemini CLI JavaScript entrypoint directly through Node.js when possible. That avoids PowerShell `.ps1` execution-policy issues and npm `.cmd` shim spawning problems.

Large prompts are sent to Gemini CLI through stdin instead of command-line arguments, which avoids Windows command-line length limits when inlining multiple files.

The bridge forwards cancellation signals to Gemini and reports a heartbeat during long-running requests. On Windows, a detached watchdog also terminates the Gemini process tree if the bridge is force-killed before it can run normal cleanup.

## Install

Add this repository as a Codex marketplace source:

```powershell
codex plugin marketplace add LeeMinhyeong/codex-gemini
codex plugin add codex-gemini@gemini-tools
```

Then restart Codex and start a new thread.

## Use

Invoke the bundled skill from Codex:

```text
$gemini-integration
Review this codebase architecture and cite the important files.
```

You can also run the bridge script directly from a repository:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --dirs src,docs "Explain the architecture and cite key files."
```

Review selected files:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --files "src/**/*.ts,src/**/*.tsx" "Review auth and input handling. Return file, risk, and fix."
```

Run a closed-book review with no Gemini tools, extensions, MCP servers, or original workspace access:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --closed-book --files "review-request.json,src/auth.ts" "Use only the serialized records and return the requested review JSON."
```

Validate a closed-book review before treating it as complete:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js `
  --closed-book `
  --format json `
  --files "review-request.json,src/auth.ts" `
  --response-schema "review-response.schema.json" `
  --scope-manifest "review-request.json" `
  --strict-scope-text `
  --output-file "review.raw.json" `
  --validation-file "review.validation.json" `
  --metadata-file "review.metadata.json" `
  "Review only the supplied records."
```

Review staged, unstaged, and untracked changes:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --changed "Review the current changes for correctness."
```

Review changes from a base branch plus the current working tree:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --base main "Review this branch as a pull request."
```

Run a larger review with an explicit timeout and saved output:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --dirs src --timeout-ms 300000 --output-file _workspace/gemini-review.md "Review the implementation and cite files."
```

Inspect the resolved Gemini command without running it:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --print-command "Summarize the project."
```

Inspect the selected files, exclusions, diff size, and estimated prompt size without calling Gemini:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --changed --plan "Review the current changes."
```

## Bridge Options

- `--dirs <path,...>`: recursively include directories
- `--files <glob,...>`: include files matching glob patterns
- `--changed`: include staged, unstaged, and untracked changes
- `--base <ref>`: include committed changes from `<ref>...HEAD` and current working-tree changes
- `--model <name>`: pass a Gemini model override
- `--format <text|json|stream-json>`: choose Gemini output format
- `--max-files <n>`: limit files inlined into the prompt
- `--max-file-bytes <n>`: limit bytes per file
- `--max-diff-bytes <n>`: limit the Git diff included in the prompt
- `--timeout-ms <n>`: kill Gemini if it runs longer than this many milliseconds; `0` disables the bridge timeout
- `--heartbeat-ms <n>`: report elapsed time, prompt size, and Gemini PID on stderr; `0` disables the heartbeat
- `--warn-prompt-bytes <n>`: warn when the generated prompt reaches this byte size; `0` disables the warning
- `--warn-prompt-tokens <n>`: warn when the approximate token estimate reaches this value
- `--fail-on-prompt-bytes <n>`: fail before calling Gemini when the generated prompt exceeds this byte size
- `--fail-on-prompt-tokens <n>`: fail when the approximate token estimate exceeds this value
- `--print-prompt-size`: print the generated prompt byte size before calling Gemini
- `--output-file <path>`: stream Gemini stdout to a workspace-local file
- `--metadata-file <path>`: write execution details and the final status as JSON
- `--response-schema <path>`: validate JSON output against a workspace-local JSON Schema
- `--scope-manifest <path>`: validate structured result paths against its `allowed_files`
- `--strict-scope-text`: also reject path-like references in free-text fields; requires `--scope-manifest`
- `--validation-file <path>`: write schema and scope validation results as JSON
- `--closed-book`: deny every Gemini tool and run the CLI in an isolated temporary workspace
- `--plan`: print the context plan without calling Gemini
- `--doctor`: check Node, Gemini CLI, live authentication, and watchdog availability
- `--print-command`: show the resolved command without running Gemini
- `--version`: print the plugin version

Unknown options fail immediately. Use `--` before task text that starts with a dash.

## Git and Ignore Rules

In a Git worktree, directory and glob collection uses `git ls-files`, so tracked files are available and ignored untracked files are excluded according to Git's normal ignore rules.

Add a workspace-root `.codex-geminiignore` for plugin-specific exclusions. It supports blank lines, comments, glob patterns, directory patterns ending in `/`, and later `!` negation rules. Sensitive-file filtering always wins over ignore negation.

## Output Contract

- Gemini output goes to stdout. Bridge diagnostics and heartbeat messages go to stderr.
- With `--output-file`, output streams to `<path>.partial` instead of accumulating in memory.
- The partial file is renamed to the requested path only after Gemini exits successfully.
- Timeout, cancellation, Gemini failure, or invalid JSON preserves the partial file.
- `--format json` must produce valid JSON before an output file is promoted.
- `--metadata-file` records timing, selected files, prompt size, Git review details, exit status, and partial-output location.
- Output validation requires `--format json`, `--output-file`, and `--validation-file`.
- The raw Gemini output is preserved unchanged at `--output-file`, including validation failures.
- Validation metadata separates `processStatus` from `validationStatus` and reports `completed-valid`, `completed-invalid-schema`, or `completed-invalid-scope`.
- Schema failures exit with code 2; scope failures exit with code 3.
- Scope validation checks reviewed files, out-of-scope files, and each finding's `file` field. `--strict-scope-text` additionally scans finding evidence, issue, recommendation, missing context, and residual risks for path-like references.
- Supported JSON Schema keywords are checked explicitly. Unsupported keywords fail before Gemini is called rather than being silently ignored.
- Closed-book runs record `executionMode: "closed-book"`, use a deny-all Gemini policy, disable extensions and MCP access, and remove the temporary workspace after exit.
- Timeout metadata distinguishes no output, partial output, and detected tool activity.

The dependency-free validator intentionally supports a review-contract subset of JSON Schema: local `$ref`, `$defs`/`definitions`, `type`, `const`, `enum`, object properties and required keys, additional properties, array items and size limits, and numeric ranges. Schema annotations such as title and description are accepted but do not affect validation.

## Privacy and Data

The bridge sends the selected file contents, task prompt, and optional Git diff to Gemini CLI. Use `--plan` to inspect the transfer plan before a sensitive review.

File contents and Git diffs are serialized as untrusted JSON data. The prompt explicitly tells Gemini not to follow instructions found inside workspace content. Absolute workspace paths are not included.

The bridge automatically skips common generated-heavy paths and likely sensitive files, including:

- `.git`, `node_modules`, `dist`, `build`, `coverage`
- `.env` and `.env.*`
- SSH keys, certificates, private keys, and credential-like files
- `.aws`, `.gcloud`, `.kube`, `.ssh`, and similar credential directories

All selected paths and output paths must stay inside the current workspace.

Treat Gemini output as a reviewer signal. Verify findings against the local code before making changes.

## Troubleshooting

Check that Gemini CLI is installed:

```powershell
gemini --version
```

If PowerShell blocks `gemini.ps1`, run the npm `.cmd` shim directly:

```powershell
& "$env:APPDATA\npm\gemini.cmd" --version
```

If Gemini reports an authentication issue:

```powershell
gemini auth
```

Run the built-in health check. This sends a small live request to verify authentication:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --doctor
```

If a large review times out, rerun it with a smaller scope or a longer explicit timeout:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --dirs backend/src --max-files 12 --max-file-bytes 8000 --timeout-ms 300000 "Review this area."
```

The bridge reports the prompt size on timeout. Use that to split the task into smaller review passes when needed.

Timeouts are optional and disabled by default. Interactive cancellation still stops the Gemini process tree, and long-running requests emit a heartbeat every 30 seconds by default.

Token counts are estimates based on prompt bytes. Gemini model tokenization and context limits vary, so configure warning or failure thresholds for the selected model when needed.

## Platform Support

- Windows: process-tree cleanup plus detached watchdog
- Linux and macOS: signal forwarding and process-group cleanup
- CI: Node.js 20 and 22 on Windows, Ubuntu, and macOS

If Codex does not show the plugin after installation, restart Codex and start a new thread.

## License

MIT. See [LICENSE](LICENSE).
