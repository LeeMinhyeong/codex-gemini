# Security Policy

## Supported Versions

Security fixes are made on the latest published version.

## Reporting a Vulnerability

Please open a private security advisory on GitHub if the repository supports it. If not, open an issue with minimal reproduction details and avoid posting secrets, tokens, or private code.

## Data Handling

This plugin can send selected local file contents to Gemini CLI. Users are responsible for choosing appropriate files and directories.

The bridge script skips common sensitive files and directories by default, including `.env` files, SSH keys, certificates, credential-like filenames, and common cloud credential folders. This filter is a guardrail, not a guarantee. Review selected paths before using the plugin on private repositories.

## Secrets

Do not intentionally send credentials, tokens, private keys, customer data, or unrelated personal data through this plugin.

If you discover a secret was sent accidentally:

1. Revoke or rotate the secret.
2. Review Gemini CLI and account activity.
3. Remove the secret from local files and history if needed.
4. File an issue or advisory if the bridge should skip an additional pattern.
