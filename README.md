<div align="center">
  <img src="apps/web/public/logo.svg" width="72" alt="StepForge logo" />
  <h1>StepForge</h1>
  <p><strong>Record once. Test every layer. Export anywhere.</strong></p>
  <p>The free, local QA studio for UI, API, database, email and performance testing.</p>
</div>

> 🚧 **Under active development.** Phase 1 (foundation) is complete; see [docs/PROGRESS.md](docs/PROGRESS.md).
> The full README arrives in Phase 13.

## Quick start

Prerequisites: **Node.js 20+** and **Git**. Nothing else.

```bash
git clone https://github.com/YOUR_USERNAME/stepforge.git
cd stepforge
./setup.sh      # Windows: setup.bat
./start.sh      # Windows: start.bat
```

StepForge opens at <http://127.0.0.1:4400>. Everything runs on your machine; data lives in `./data`.

## Development

```bash
npm run dev         # API with auto-restart + dashboard with hot reload at http://127.0.0.1:5173
npm test            # unit tests (Vitest)
npm run test:e2e    # dashboard E2E (Playwright)
npm run lint && npm run typecheck
```

## License

[MIT](LICENSE) © Muzahidul Rahman
