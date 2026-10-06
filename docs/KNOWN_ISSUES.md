# Known Issues

| # | Area | Issue | Status / workaround |
|---|---|---|---|
| 1 | Scripts | `setup.bat` and `start.bat` have not yet been executed on a real Windows machine (built on macOS). CI on `windows-latest` runs the same npm commands but not the `.bat` wrappers. | To verify in Phase 13 fresh-clone test. |
| 2 | Dependencies | `.npmrc` sets `legacy-peer-deps=true`. npm 10's peer resolver crashes (`Cannot read properties of null (reading 'edgesOut')`) on Vitest's optional browser peer set. All real peer dependencies are declared explicitly, so nothing is lost. | Revisit when npm fixes the resolver. |
| 3 | Dependencies (dev only) | `npm audit` reports a moderate advisory in the `esbuild` copy bundled by `drizzle-kit` (`@esbuild-kit`). It only affects esbuild's dev *server*, which drizzle-kit never starts; drizzle-kit only runs for `npm run db:generate`. Runtime dependencies: 0 vulnerabilities. | Upgrade when drizzle-kit drops `@esbuild-kit`. |
| 4 | Modules | `modules.parent_id` is a self-reference without a SQL foreign key (avoids a circular Drizzle type). Integrity (no orphans, no cycles) is enforced in the repository layer from Phase 2. | By design. |
| 5 | Versioning | Scenario versions cover details + steps. Test cases and tags are not versioned (test case IDs are referenced by run history, so restoring them would break links). | By design; documented in the History tab. |
| 6 | Explorer | Drag-and-drop uses native HTML5 DnD (mouse only). Scenarios can also be moved without a mouse via the bulk "Move to…" action; modules can currently only be re-parented by dragging. | Add a "Move module to…" action in Phase 4. |
| 7 | Engine | `util.if`, `util.loop`, `util.callScenario`, `util.useBlock` and `ui.visualCheckpoint` are reported as `unsupported` (test → `broken`). | Control flow lands with the Scenario Editor in Phase 4; visual checkpoints later. |
| 8 | Sandbox | `util.runScript` uses `node:vm` with a timeout and no `require`/`process`/`eval`. `node:vm` isolates globals but is not a hardened security boundary; scripts are written by the StepForge user on their own machine. | By design; documented in STEP_REFERENCE. |
| 9 | Runner | Live run logs are streamed over WebSocket but not stored; after a run, evidence is the step results, console/network logs, video and trace. Steps are read when each test case starts, so editing a scenario during its own run affects test cases not started yet (the item records the version it actually ran). | Revisit with the CLI in Phase 11. |
| 10 | Runner | One run executes at a time (others queue); parallelism is per run (`workers`). | By design for a local tool. |
