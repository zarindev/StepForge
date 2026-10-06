import type { StepForgeDb } from '@stepforge/db';
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { ServerConfig } from './config.ts';
import type { SpecService } from './api/specs.ts';
import type { DatabaseService } from './database/service.ts';
import type { EmailService } from './email/service.ts';
import type { PerfService } from './perf/service.ts';
import type { DiagnosisService } from './diagnosis/service.ts';
import type { SchedulerService } from './scheduler/service.ts';
import type { CodegenService } from './codegen/service.ts';
import type { RecorderManager } from './recorder/manager.ts';
import type { RunManager } from './runner/manager.ts';

/** Live events pushed to dashboard clients over the WebSocket. */
export type LiveEvent = { type: string; [key: string]: unknown };

export class EventBus extends EventEmitter {
  publish(event: LiveEvent): void {
    this.emit('event', event);
  }
}

export type AppContext = {
  config: ServerConfig;
  db: StepForgeDb;
  sqlite: Database.Database;
  masterKey: Buffer;
  token: string;
  bus: EventBus;
  runs: RunManager;
  recorder: RecorderManager;
  specs: SpecService;
  database: DatabaseService;
  email: EmailService;
  perf: PerfService;
  diagnosis: DiagnosisService;
  scheduler: SchedulerService;
  codegen: CodegenService;
  startedAt: Date;
};
