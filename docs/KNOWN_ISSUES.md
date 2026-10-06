# Known Issues

| # | Area | Issue | Status / workaround |
|---|---|---|---|
| 1 | Scripts | `setup.bat` and `start.bat` have not yet been executed on a real Windows machine (built on macOS). CI on `windows-latest` runs the same npm commands but not the `.bat` wrappers. | To verify in Phase 13 fresh-clone test. |
| 2 | Dependencies | `.npmrc` sets `legacy-peer-deps=true`. npm 10's peer resolver crashes (`Cannot read properties of null (reading 'edgesOut')`) on Vitest's optional browser peer set. All real peer dependencies are declared explicitly, so nothing is lost. | Revisit when npm fixes the resolver. |
| 3 | Dependencies (dev only) | `npm audit` reports a moderate advisory in the `esbuild` copy bundled by `drizzle-kit` (`@esbuild-kit`). It only affects esbuild's dev *server*, which drizzle-kit never starts; drizzle-kit only runs for `npm run db:generate`. Runtime dependencies: 0 vulnerabilities. | Upgrade when drizzle-kit drops `@esbuild-kit`. |
| 4 | Modules | `modules.parent_id` is a self-reference without a SQL foreign key (avoids a circular Drizzle type). Integrity (no orphans, no cycles) is enforced in the repository layer from Phase 2. | By design. |
| 5 | Versioning | Scenario versions cover details + steps. Test cases and tags are not versioned (test case IDs are referenced by run history, so restoring them would break links). | By design; documented in the History tab. |
| 6 | Explorer | Drag-and-drop uses native HTML5 DnD (mouse only). | Resolved in Phase 4: bulk “Move to…” for scenarios and “Move to…” for modules. |
| 7 | Engine | `ui.visualCheckpoint` is reported as `unsupported` (test → `broken`). Control flow landed in Phase 4. | Visual checkpoints are not scheduled in a specific phase yet. |
| 8 | Sandbox | `util.runScript` uses `node:vm` with a timeout and no `require`/`process`/`eval`. `node:vm` isolates globals but is not a hardened security boundary; scripts are written by the StepForge user on their own machine. | By design; documented in STEP_REFERENCE. |
| 9 | Runner | Live run logs are streamed over WebSocket but not stored; after a run, evidence is the step results, console/network logs, video and trace. Steps are read when each test case starts, so editing a scenario during its own run affects test cases not started yet (the item records the version it actually ran). | Revisit with the CLI in Phase 11. |
| 10 | Runner | One run executes at a time (others queue); parallelism is per run (`workers`). | By design for a local tool. |
| 11 | Recorder | `util.if` conditions compare values (`{{vars.x}} gt 3`); there is no “element is visible” condition yet. Use `ui.extract` with `count` into a variable, then compare it. | Possible later improvement. |
| 12 | Recorder | Uploads record file *names* only (browsers do not expose paths); the step is labelled “Choose the file path before replaying”. Drag-and-drop, hover-only menus and canvas interactions are not recorded automatically; add them in the editor. | By design. |
| 13 | Recorder | One recording at a time. The recording browser is always Chromium; replays can use any browser. | By design. |
| 14 | E2E | Dashboard E2E specs run serially because they share one CareClinic instance. | By design. |
| 15 | Bundle | The dashboard's main JS chunk is ~760 kB (231 kB gzip); Monaco (~3 MB) and React Flow are lazy-loaded. Fine for localhost; revisit splitting in Phase 13. | Phase 13. |
| 16 | API | OAuth2 supports the client-credentials grant only (authorization-code flows need a browser; record them with the Recorder or store a token as a secret). | By design. |
| 17 | API | Generated happy paths use the spec's examples as-is, so non-idempotent ones (e.g. booking a fixed slot) pass once per data reset. Use test cases with `{{random.*}}`/generated data for repeatable runs. | Documented. |
| 18 | API | In the API Client, variables set during runs (e.g. `{{vars.auth.token}}` from the Authenticate block) are not available; the client explains which variable is missing. | By design. |
| 19 | Importers | CSV datasets (data-driven runs) are not imported yet. | Planned with datasets. |
