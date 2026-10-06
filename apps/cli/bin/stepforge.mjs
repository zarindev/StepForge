#!/usr/bin/env node
// StepForge CLI (by Md Zarin Tasnim). The workspace ships TypeScript sources, so load them through tsx.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
