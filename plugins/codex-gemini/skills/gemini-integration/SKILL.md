---
name: gemini-integration
description: Use Gemini CLI for long-context codebase exploration, architecture review, refactor impact analysis, documentation synthesis, security review, or structured data analysis when Codex should hand off a broad cross-file problem instead of solving it file-by-file.
---

# Gemini Integration

Use this skill when a task benefits from a broad Gemini CLI pass over many files or a large text/data slice.

## When To Use

- Whole-codebase or multi-module architecture understanding
- Cross-file security or data-flow review
- Refactor impact analysis
- Unfamiliar codebase orientation
- Documentation synthesis from many source files
- Structured data review across JSON, YAML, TOML, CSV, Markdown, SQL, or code

Avoid it for quick single-file edits, tight interactive debugging, or narrow tasks where Codex already has the needed context.

## Runtime

Prefer the bundled bridge script over hand-written `gemini` commands:

```powershell
node <plugin-root>\scripts\gemini-bridge.js [options] <task>
```

When resolving from this skill folder, the script is at:

```text
../../scripts/gemini-bridge.js
```

The bridge:

- collects requested files and directories locally
- skips binary and generated-heavy paths
- skips common secret files such as `.env`, SSH keys, certificates, credentials, and service account files
- inlines text-like files into a structured prompt
- serializes file contents and Git diffs as untrusted JSON data
- invokes `gemini` in headless mode
- forwards cancellation signals and supervises the Gemini process tree
- reports heartbeat progress for long-running requests
- asks Gemini to cite file paths and call out partial context

## Options

- `--dirs <path,...>`: recursively include directories
- `--files <glob,...>`: include files matching glob patterns
- `--changed`: include staged, unstaged, and untracked changes
- `--base <ref>`: include `<ref>...HEAD` and current working-tree changes
- `--model <name>`: pass a Gemini model override only when requested
- `--format <text|json|stream-json>`: choose Gemini output format
- `--max-files <n>`: limit files inlined into the prompt
- `--max-file-bytes <n>`: limit bytes per file
- `--max-diff-bytes <n>`: limit Git diff bytes
- `--timeout-ms <n>`: kill Gemini if it runs longer than this many milliseconds; `0` disables the bridge timeout
- `--heartbeat-ms <n>`: report elapsed time, prompt size, and Gemini PID on stderr; `0` disables the heartbeat
- `--warn-prompt-bytes <n>`: warn when the generated prompt reaches this byte size; `0` disables the warning
- `--warn-prompt-tokens <n>`: warn on approximate prompt tokens
- `--fail-on-prompt-bytes <n>`: fail before calling Gemini when the generated prompt exceeds this byte size
- `--fail-on-prompt-tokens <n>`: fail on approximate prompt tokens
- `--print-prompt-size`: print the generated prompt byte size before calling Gemini
- `--output-file <path>`: stream Gemini stdout through a `.partial` file
- `--metadata-file <path>`: write execution metadata as JSON
- `--plan`: inspect selected context without calling Gemini
- `--doctor`: verify Gemini CLI and authentication with a small live request
- `--print-command`: inspect the resolved Gemini command without running it

## Patterns

Architecture review:

```powershell
node <plugin-root>\scripts\gemini-bridge.js --dirs src,docs "Explain the architecture and cite the key files."
```

Current-change review:

```powershell
node <plugin-root>\scripts\gemini-bridge.js --changed --plan "Review the current changes."
node <plugin-root>\scripts\gemini-bridge.js --changed --output-file _workspace/gemini-review.md "Review the current changes."
```

Refactor impact:

```powershell
node <plugin-root>\scripts\gemini-bridge.js --dirs src "Analyze the impact of refactoring the auth module. Include affected files and migration steps."
```

Security review:

```powershell
node <plugin-root>\scripts\gemini-bridge.js --files "src/**/*.ts,src/**/*.tsx" --timeout-ms 300000 --output-file _workspace/gemini-security-review.md "Review auth and input handling. Output file:line, risk, and recommended fix."
```

Structured data:

```powershell
node <plugin-root>\scripts\gemini-bridge.js --files "schemas/**/*.json,data/**/*.csv" "Summarize the contracts and identify breaking changes."
```

## Practical Rules

- Narrow the context deliberately with `--dirs` or `--files`.
- Prefer `--changed` for implementation reviews and `--base <ref>` for branch or pull-request reviews.
- Use `--plan` before sending broad or sensitive context.
- Respect `.gitignore`; add `.codex-geminiignore` for plugin-specific exclusions.
- Leave `--timeout-ms` at `0` for interactive reviews unless a hard execution bound is useful.
- Use `--timeout-ms` for CI, unattended jobs, or explicitly bounded review passes.
- Treat heartbeat messages as progress diagnostics; they are written to stderr and do not alter Gemini output.
- Treat token counts as estimates and choose thresholds based on the selected model.
- When using `--output-file`, expect `.partial` output to remain after timeout, cancellation, invalid JSON, or Gemini failure.
- Use `--metadata-file` when another workflow needs a deterministic handoff record.
- If a timeout happens, reduce `--max-files` or `--max-file-bytes`, split by module, or raise `--timeout-ms`.
- Do not send secrets, private credentials, or unrelated user data to Gemini.
- Ask for a concrete output format when using Gemini for review.
- Treat Gemini output as another reviewer, not an authority.
- Verify actionable findings against the local code before changing files.
- If Gemini CLI is missing, tell the user to install `@google/gemini-cli`.
- If authentication fails, tell the user to run `gemini auth`.
