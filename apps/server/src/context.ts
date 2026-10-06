import type { StepForgeDb } from '@stepforge/db';
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { ServerConfig } from './config.ts';

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
  startedAt: Date;
};
