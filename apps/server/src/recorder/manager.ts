import {
  newId,
  StepError,
  VariableResolver,
  type AndroidLaunch,
  type ElectronLaunch,
  type IosLaunch,
  type StepInput,
} from '@stepforge/core';
import {
  androidPlatform,
  iosPlatform,
  NativeRecordingSession,
  type AppiumServer,
} from '@stepforge/executor-native';
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
  /** A browser or desktop app (Playwright), or a phone app (Appium). */
  session: RecordingSession | NativeRecordingSession;
};

/** One recording at a time; the dashboard follows it live over the WebSocket. */
export class RecorderManager {
  private active: Active | null = null;
  /**
   * A recording that is starting (the app or browser takes seconds to open): a second start is refused meanwhile,
   * and a stop or discard sent meanwhile closes the session as soon as it is there.
   */
  private starting: { cancelled: boolean } | null = null;
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

  /** The local Appium server, for recording phone apps (set by the server). */
  appium?: AppiumServer;

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
    if (this.starting)
      throw new repo.RepoError(409, 'conflict', 'A recording is already starting. Wait for it, or stop it.');
    if (this.active && this.active.session.state !== 'stopped') {
      throw new repo.RepoError(409, 'conflict', 'A recording is already in progress. Stop it first.');
    }
    // Marked before the first wait, so two quick clicks cannot start two sessions.
    const starting = { cancelled: false };
    this.starting = starting;
    try {
      return await this.begin(d, starting);
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  /** A start that was stopped while the session opened: the session is closed and the start reports it. */
  private async abandon(session: { stop(): Promise<unknown> }): Promise<never> {
    await session.stop().catch(() => undefined);
    throw new repo.RepoError(409, 'conflict', 'The recording was stopped while it was starting');
  }

  private async begin(d: z.output<typeof StartRecordingInput>, starting: { cancelled: boolean }) {
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
    const platform = repo.getApplication(this.db, d.applicationId).platform;
    const resolver = () =>
      new VariableResolver({
        env: { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name },
        secret: repo.resolveSecrets(this.db, this.masterKey, env.id),
      });
    if (platform === 'macos' || platform === 'windows' || platform === 'linux')
      throw new repo.RepoError(
        400,
        'invalid',
        `Recording ${{ macos: 'macOS', windows: 'Windows', linux: 'Linux' }[platform]} apps is planned; add the steps in the editor for now`,
      );
    if (platform === 'android' || platform === 'ios') {
      // A phone app: started through Appium; the dashboard shows its screen and sends the taps.
      if (!this.appium) throw new repo.RepoError(400, 'invalid', 'Phone apps are not available here');
      const defaults = env.browserDefaultsJson as { android?: AndroidLaunch; ios?: IosLaunch };
      const native =
        platform === 'ios'
          ? iosPlatform(resolver().resolve(defaults.ios ?? {}) as IosLaunch)
          : androidPlatform(resolver().resolve(defaults.android ?? {}) as AndroidLaunch);
      if (!this.appium.hasDriver(native.driver))
        throw new repo.RepoError(
          400,
          'invalid',
          `Appium's ${native.name} driver is not installed: run "npm run appium:install" (or Install Appium on the Environments tab)`,
        );
      const id = newId();
      let session: NativeRecordingSession;
      try {
        session = await NativeRecordingSession.start({
          appiumUrl: await this.appium.url(),
          platform: native,
          startUrl: env.baseUrl,
          onChange: () => this.publish(),
          onStop: (snap) => this.stopped(id, snap, d, env.baseUrl, target, session.secrets),
        });
      } catch (err) {
        throw new repo.RepoError(
          400,
          'invalid',
          err instanceof StepError ? err.message : (err as Error).message,
        );
      }
      if (starting.cancelled) return this.abandon(session);
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
    // A desktop (Electron) app is recorded in its own windows, started as its environment says.
    const desktop = platform === 'electron';
    const electron = desktop
      ? (new VariableResolver({
          env: { ...env.variablesJson, baseUrl: env.baseUrl, name: env.name },
          secret: repo.resolveSecrets(this.db, this.masterKey, env.id),
        }).resolve(
          (env.browserDefaultsJson as { electron?: ElectronLaunch }).electron ?? {},
        ) as ElectronLaunch)
      : undefined;
    const id = newId();
    const session = await RecordingSession.start({
      startUrl,
      baseUrl: env.baseUrl,
      ...(electron && { electron }),
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
    if (starting.cancelled) return this.abandon(session);
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

  /** The live browser session (tests drive its page). */
  session(): RecordingSession | null {
    const s = this.active?.session;
    return s instanceof RecordingSession ? s : null;
  }

  /** The live phone-app session: the dashboard's screen mirror sends its taps here. */
  native(): NativeRecordingSession {
    const s = this.active?.session;
    if (!(s instanceof NativeRecordingSession))
      throw new repo.RepoError(409, 'conflict', 'No phone app is being recorded');
    return s;
  }

  private stopped(
    id: string,
    snap: RecorderSnapshot,
    d: { applicationId: string; environmentId: string },
    baseUrl: string,
    target: RecordingTarget | null,
    secrets: Record<string, string>,
  ): void {
    if (this.active?.id === id) {
      this.last = {
        ...snap,
        id,
        applicationId: d.applicationId,
        environmentId: d.environmentId,
        baseUrl,
        target,
        secrets: { ...secrets },
      };
      this.active = null;
    }
    this.publish();
  }

  async stop() {
    if (this.starting) this.starting.cancelled = true;
    if (this.active) await this.active.session.stop();
    return this.status();
  }

  undo() {
    this.active?.session.undo();
    return this.status();
  }

  discard(): void {
    if (this.starting) this.starting.cancelled = true;
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
    // Steps whose best locator matches a saved element use the element, so they share its future fixes.
    const steps = repo.linkKnownElements(
      this.db,
      rec.applicationId,
      (d.steps ?? rec.steps).map((s) => {
        const { id: _id, describe: _d, ...rest } = s as Record<string, unknown>;
        return rest as StepInput;
      }),
    );
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
