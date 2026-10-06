# Known Issues

| # | Area | Issue | Status / workaround |
|---|---|---|---|
| 1 | Scripts | `setup.bat` and `start.bat` have not yet been executed on a real Windows machine (built on macOS). CI on `windows-latest` runs the same npm commands but not the `.bat` wrappers. | To verify in Phase 13 fresh-clone test. |
| 2 | Dependencies | `.npmrc` sets `legacy-peer-deps=true`. npm 10's peer resolver crashes (`Cannot read properties of null (reading 'edgesOut')`) on Vitest's optional browser peer set. All real peer dependencies are declared explicitly, so nothing is lost. | Revisit when npm fixes the resolver. |
| 3 | Dependencies (dev only) | `npm audit` reports a moderate advisory in the `esbuild` copy bundled by `drizzle-kit` (`@esbuild-kit`). It only affects esbuild's dev *server*, which drizzle-kit never starts; drizzle-kit only runs for `npm run db:generate`. Runtime dependencies: 0 vulnerabilities. | Upgrade when drizzle-kit drops `@esbuild-kit`. |
| 4 | Modules | `modules.parent_id` is a self-reference without a SQL foreign key (avoids a circular Drizzle type). Integrity (no orphans, no cycles) is enforced in the repository layer from Phase 2. | By design. |
| 5 | Versioning | Scenario versions cover details + steps. Test cases and tags are not versioned (test case IDs are referenced by run history, so restoring them would break links). | By design; documented in the History tab. |
| 6 | Explorer | Drag-and-drop uses native HTML5 DnD (mouse only). Keyboard users can move scenarios with the bulk "Move to…" action and modules via the parent picker (Phase 4 adds a module edit dialog). | Accessible alternative exists for scenarios. |
