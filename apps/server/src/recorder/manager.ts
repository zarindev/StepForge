import { newId, type StepInput } from '@stepforge/core';
import type { StepForgeDb } from '@stepforge/db';
import * as repo from '@stepforge/db/repos';
import { networkToApiSteps, RecordingSession, type RecorderSnapshot } from '@stepforge/recorder';
import { z } from 'zod';
import type { EventBus } from '../context.ts';

export const StartRecordingInput = z.object({
  applicationId: z.string(),
  environmentId: z.string(),
  startPath: z.string().default('/'),
  /** Headless recording is only for automated tests of StepForge itself. */
  headless: z.boolean().default(false),
});

export const SaveRecordingInput = z.object({
  moduleId: z.string(),
  name: z.string().min(1).max(200),
  /** The reviewed steps (may be edited/reordered by the user); defaults to the recorded ones. */
  steps: z.array(z.record(z.string(), z.unknown())).optional(),
  saveSecrets: z.boolean().default(true),
  apiScenario: z.object({ name: z.string().min(1), requestIds: z.array(z.number()).min(1) }).optional(),
});

type Active = {
  id: string;
  applicationId: string;
  environmentId: string;
  baseUrl: string;
  session: RecordingSession;
};

/** One recording at a time; the dashboard follows it live over the WebSocket. */
export class RecorderManager {
  private active: Active | null = null;
  private last:
    | (RecorderSnapshot & {
        id: string;
        applicationId: string;
        environmentId: string;
        baseUrl: string;
        secrets: Record<string, string>;
      })
    | null = null;

  constructor(
    private readonly db: StepForgeDb,
    private readonly masterKey: Buffer,
    private readonly bus: EventBus,
  ) {}

  status() {
    if (this.active)
      return {
        id: this.active.id,
        applicationId: this.active.applicationId,
        environmentId: this.active.environmentId,
        baseUrl: this.active.baseUrl,
        ...this.active.session.snapshot(),
      };
    if (this.last) {
      const { secrets: _s, ...rest } = this.last;
      return rest;
    }
    return null;
  }

  private publish(): void {
    this.bus.publish({ type: 'recorder.updated', recording: this.status() });
  }

  async start(input: z.input<typeof StartRecordingInput>) {
    const d = StartRecordingInput.parse(input);
    if (this.active && this.active.session.state !== 'stopped') {
      throw new repo.RepoError(409, 'conflict', 'A recording is already in progress. Stop it first.');
    }
    const env = repo.getEnvironment(this.db, d.environmentId);
    if (env.applicationId !== d.applicationId)
      throw new repo.RepoError(400, 'invalid', 'Environment belongs to another application');
    const startUrl = new URL(
      d.startPath || '/',
      env.baseUrl.endsWith('/') ? env.baseUrl : `${env.baseUrl}/`,
    ).toString();
    const id = newId();
    const session = await RecordingSession.start({
      startUrl,
      baseUrl: env.baseUrl,
      // Test-only switches (CI has no display; E2E drives the recording browser over CDP).
      headless: d.headless || process.env.STEPFORGE_RECORDER_HEADLESS === '1',
      cdpPort: process.env.STEPFORGE_RECORDER_CDP_PORT
        ? Number(process.env.STEPFORGE_RECORDER_CDP_PORT)
        : undefined,
      onChange: () => this.publish(),
      onStop: (snap) => {
        if (this.active?.id === id) {
          this.last = {
            ...snap,
            id,
            applicationId: d.applicationId,
            environmentId: d.environmentId,
            baseUrl: env.baseUrl,
            secrets: { ...session.secrets },
          };
          this.active = null;
        }
        this.publish();
      },
    });
    this.active = {
      id,
      applicationId: d.applicationId,
      environmentId: d.environmentId,
      baseUrl: env.baseUrl,
      session,
    };
    this.last = null;
    this.publish();
    return this.status();
  }

  /** The live session (tests drive its page). */
  session(): RecordingSession | null {
    return this.active?.session ?? null;
  }

  async stop() {
    if (this.active) await this.active.session.stop();
    return this.status();
  }

  undo() {
    this.active?.session.undo();
    return this.status();
  }

  discard(): void {
    void this.active?.session.stop();
    this.active = null;
    this.last = null;
    this.publish();
  }

  /** Saves the finished recording as a scenario (+ optional API scenario from captured requests). */
  save(input: z.input<typeof SaveRecordingInput>) {
    const d = SaveRecordingInput.parse(input);
    if (this.active) throw new repo.RepoError(409, 'conflict', 'Stop the recording before saving it');
    const rec = this.last;
    if (!rec) throw new repo.RepoError(404, 'not_found', 'There is no finished recording to save');
    if (repo.applicationIdForModule(this.db, d.moduleId) !== rec.applicationId) {
      throw new repo.RepoError(400, 'invalid', 'Choose a module in the recorded application');
    }
    const steps = (d.steps ?? rec.steps).map((s) => {
      const { id: _id, describe: _d, ...rest } = s as Record<string, unknown>;
      return rest as StepInput;
    });
    let scenario!: repo.ScenarioDetail;
    let apiScenario: repo.ScenarioDetail | undefined;
    this.db.transaction(() => {
      scenario = repo.createScenario(this.db, d.moduleId, {
        name: d.name,
        description: `Recorded on ${new Date().toLocaleString()} from ${rec.startUrl}`,
        status: 'draft',
        steps,
      });
      if (d.saveSecrets) {
        for (const [key, value] of Object.entries(rec.secrets))
          repo.setSecret(this.db, this.masterKey, rec.environmentId, { key, value });
      }
      if (d.apiScenario) {
        const chosen = rec.network.filter((n) => d.apiScenario!.requestIds.includes(n.id));
        apiScenario = repo.createScenario(this.db, d.moduleId, {
          name: d.apiScenario.name,
          description: `${chosen.length} request(s) captured while recording "${d.name}"`,
          status: 'draft',
          steps: networkToApiSteps(chosen, rec.baseUrl),
        });
      }
    });
    this.last = null;
    this.publish();
    this.bus.publish({ type: 'tree.changed', applicationId: rec.applicationId });
    return { scenario, apiScenario };
  }
}
