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
  /** Started from the Test Explorer: add the steps to this scenario… */
  scenarioId: z.string().optional(),
  /** …or save the new scenario into this module. */
  moduleId: z.string().optional(),
});

/** Where a recording started from the Test Explorer goes when it is saved. */
export type RecordingTarget = {
  scenarioId?: string;
  scenarioName?: string;
  existingSteps?: number;
  moduleId?: string;
};

export const SaveRecordingInput = z.object({
  /** Append the recorded steps to this existing scenario (moduleId and name are then not needed). */
  scenarioId: z.string().optional(),
  moduleId: z.string().optional(),
  name: z.string().min(1).max(200).optional(),
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
  target: RecordingTarget | null;
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
        target: RecordingTarget | null;
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
        target: this.target(this.active.target),
        ...this.active.session.snapshot(),
      };
    if (this.last) {
      const { secrets: _s, target, ...rest } = this.last;
      return { ...rest, target: this.target(target) };
    }
    return null;
  }

  /** The target with the scenario's current name and step count (it may have been renamed or deleted meanwhile). */
  private target(t: RecordingTarget | null): RecordingTarget | null {
    if (!t?.scenarioId) return t;
    try {
      const s = repo.getScenario(this.db, t.scenarioId);
      return { scenarioId: s.id, scenarioName: s.name, existingSteps: s.steps.length, moduleId: s.moduleId };
    } catch {
      return null;
    }
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
    let target: RecordingTarget | null = null;
    if (d.scenarioId) {
      if (repo.applicationIdForScenario(this.db, d.scenarioId) !== d.applicationId)
        throw new repo.RepoError(400, 'invalid', 'The scenario belongs to another application');
      target = { scenarioId: d.scenarioId };
    } else if (d.moduleId) {
      if (repo.applicationIdForModule(this.db, d.moduleId) !== d.applicationId)
        throw new repo.RepoError(400, 'invalid', 'The module belongs to another application');
      target = { moduleId: d.moduleId };
    }
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
            target,
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
      target,
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

  /**
   * Saves the finished recording as a new scenario, or appends its steps to an existing one (`scenarioId`), plus an
   * optional API scenario from captured requests.
   */
  save(input: z.input<typeof SaveRecordingInput>) {
    const d = SaveRecordingInput.parse(input);
    if (this.active) throw new repo.RepoError(409, 'conflict', 'Stop the recording before saving it');
    const rec = this.last;
    if (!rec) throw new repo.RepoError(404, 'not_found', 'There is no finished recording to save');
    let existing: repo.ScenarioDetail | undefined;
    if (d.scenarioId) {
      if (repo.applicationIdForScenario(this.db, d.scenarioId) !== rec.applicationId)
        throw new repo.RepoError(400, 'invalid', 'Choose a scenario in the recorded application');
      existing = repo.getScenario(this.db, d.scenarioId);
    } else {
      if (!d.moduleId || !d.name)
        throw new repo.RepoError(400, 'invalid', 'Give the scenario a name and choose a module');
      if (repo.applicationIdForModule(this.db, d.moduleId) !== rec.applicationId)
        throw new repo.RepoError(400, 'invalid', 'Choose a module in the recorded application');
    }
    const moduleId = existing?.moduleId ?? d.moduleId!;
    const name = existing?.name ?? d.name!;
    const steps = (d.steps ?? rec.steps).map((s) => {
      const { id: _id, describe: _d, ...rest } = s as Record<string, unknown>;
      return rest as StepInput;
    });
    let scenario!: repo.ScenarioDetail;
    let apiScenario: repo.ScenarioDetail | undefined;
    this.db.transaction(() => {
      scenario = existing
        ? repo.saveSteps(this.db, existing.id, [
            ...(existing.steps as unknown as (StepInput & { id?: string })[]),
            ...steps,
          ])
        : repo.createScenario(this.db, moduleId, {
            name,
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
        apiScenario = repo.createScenario(this.db, moduleId, {
          name: d.apiScenario.name,
          description: `${chosen.length} request(s) captured while recording "${name}"`,
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
