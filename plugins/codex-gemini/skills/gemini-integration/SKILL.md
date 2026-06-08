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
- invokes `gemini` in headless mode
- asks Gemini to cite file paths and call out partial context

## Options

- `--dirs <path,...>`: recursively include directories
- `--files <glob,...>`: include files matching glob patterns
- `--model <name>`: pass a Gemini model override only when requested
- `--format <text|json|stream-json>`: choose Gemini output format
- `--max-files <n>`: limit files inlined into the prompt
- `--max-file-bytes <n>`: limit bytes per file
- `--timeout-ms <n>`: kill Gemini if it runs longer than this many milliseconds; `0` disables the bridge timeout
- `--warn-prompt-bytes <n>`: warn when the generated prompt reaches this byte size; `0` disables the warning
- `--fail-on-prompt-bytes <n>`: fail before calling Gemini when the generated prompt exceeds this byte size
- `--print-prompt-size`: print the generated prompt byte size before calling Gemini
- `--output-file <path>`: write Gemini stdout to a workspace-local file
- `--print-command`: inspect the resolved Gemini command without running it

## Patterns

Architecture review:

```powershell
node <plugin-root>\scripts\gemini-bridge.js --dirs src,docs "Explain the architecture and cite the key files."
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
- For broad code review, set `--timeout-ms` and split the task if the prompt-size warning appears.
- If a timeout happens, reduce `--max-files` or `--max-file-bytes`, split by module, or raise `--timeout-ms`.
- Do not send secrets, private credentials, or unrelated user data to Gemini.
- Ask for a concrete output format when using Gemini for review.
- Treat Gemini output as another reviewer, not an authority.
- Verify actionable findings against the local code before changing files.
- If Gemini CLI is missing, tell the user to install `@google/gemini-cli`.
- If authentication fails, tell the user to run `gemini auth`.
