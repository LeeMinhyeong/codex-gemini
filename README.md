# Codex Gemini

Codex Gemini is a local Codex plugin that lets Codex delegate broad codebase analysis and review tasks to the Gemini CLI.

Use it when a task benefits from a large-context pass over many files, such as architecture review, refactor impact analysis, security review, documentation synthesis, or structured data analysis.

This is not an official OpenAI or Google plugin.

## Requirements

- Codex with plugin support
- Node.js available on `PATH`
- Gemini CLI installed and authenticated

Install Gemini CLI:

```powershell
npm install -g @google/gemini-cli
gemini auth
```

On Windows, this plugin invokes the Gemini CLI JavaScript entrypoint directly through Node.js when possible. That avoids PowerShell `.ps1` execution-policy issues and npm `.cmd` shim spawning problems.

Large prompts are sent to Gemini CLI through stdin instead of command-line arguments, which avoids Windows command-line length limits when inlining multiple files.

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

Inspect the resolved Gemini command without running it:

```powershell
node plugins/codex-gemini/scripts/gemini-bridge.js --print-command "Summarize the project."
```

## Bridge Options

- `--dirs <path,...>`: recursively include directories
- `--files <glob,...>`: include files matching glob patterns
- `--model <name>`: pass a Gemini model override
- `--format <text|json|stream-json>`: choose Gemini output format
- `--max-files <n>`: limit files inlined into the prompt
- `--max-file-bytes <n>`: limit bytes per file
- `--print-command`: show the resolved command without running Gemini

## Privacy and Data

The bridge sends the selected file contents and task prompt to Gemini CLI. Use narrow `--dirs` or `--files` scopes and review what you are asking Gemini to analyze.

The bridge automatically skips common generated-heavy paths and likely sensitive files, including:

- `.git`, `node_modules`, `dist`, `build`, `coverage`
- `.env` and `.env.*`
- SSH keys, certificates, private keys, and credential-like files
- `.aws`, `.gcloud`, `.kube`, `.ssh`, and similar credential directories

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

If Codex does not show the plugin after installation, restart Codex and start a new thread.

## License

MIT. See [LICENSE](LICENSE).
