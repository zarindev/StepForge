# Security policy

_By Md Zarin Tasnim · part of the StepForge documentation_

## How StepForge protects your data

- The server binds to `127.0.0.1` only. A random session token is created at every start and required on every API
  request and WebSocket, and the Host header is checked, so other websites and other machines cannot call it.
- Secrets are encrypted with AES-256-GCM using a master key in `data/.key` (created on first run, readable only by
  your user where the OS supports it). The key can be rotated in Settings; the old key is kept as a backup file.
- Secrets are masked as `••••` in the dashboard, reports, logs and evidence, and are never included in application
  exports or generated code (exported projects read them from environment variables).
- Request bodies and headers are not logged.
- Script steps run in a `node:vm` sandbox with a time limit and no `require`, `process`, file system or network. It
  is not a hardened security boundary: only run scripts you trust.
- Database connections default to read-only with rollback; destructive statements need explicit settings and, on
  production, typing the application name.
- `data/` and `.env` are git-ignored, and `npm run check:secrets` fails CI if they are committed.

## Supported versions

The latest release on the main branch.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability) or contact the maintainer through the profile linked in the README. Include steps to
reproduce and the impact. You will get a reply as soon as possible, and credit in the fix if you wish.
