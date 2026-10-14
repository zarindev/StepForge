import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/input';
import { toast, toastError } from '@/components/ui/toast';
import { api } from '@/lib/api';

export type NativeStatus = {
  ready: boolean;
  installing: boolean;
  checks: { name: string; ok: boolean; detail: string; fix?: string }[];
  avds: string[];
  devices: { serial: string; state: string; model?: string; emulator: boolean }[];
};
const STATUS_KEY = ['native-status'];
export const useNativeStatus = (enabled = true) =>
  useQuery({ queryKey: STATUS_KEY, queryFn: () => api<NativeStatus>('/api/native/status'), enabled });

type AndroidLaunch = {
  app?: string;
  appPackage?: string;
  appActivity?: string;
  avd?: string;
  udid?: string;
  resetApp?: boolean;
  showEmulator?: boolean;
  capabilities?: Record<string, unknown>;
};
export type AndroidForm = {
  app: string;
  appPackage: string;
  appActivity: string;
  avd: string;
  udid: string;
  resetApp: boolean;
  showEmulator: boolean;
  capabilities: string;
};

export function androidToForm(v: unknown): AndroidForm {
  const a = (v ?? {}) as AndroidLaunch;
  return {
    app: a.app ?? '',
    appPackage: a.appPackage ?? '',
    appActivity: a.appActivity ?? '',
    avd: a.avd ?? '',
    udid: a.udid ?? '',
    resetApp: a.resetApp ?? true,
    showEmulator: a.showEmulator ?? false,
    capabilities:
      a.capabilities && Object.keys(a.capabilities).length ? JSON.stringify(a.capabilities, null, 2) : '',
  };
}

/** The launch settings to save; throws a readable message when the extra capabilities are not a JSON object. */
export function formToAndroid(f: AndroidForm): AndroidLaunch {
  let capabilities: Record<string, unknown> = {};
  if (f.capabilities.trim()) {
    try {
      capabilities = JSON.parse(f.capabilities) as Record<string, unknown>;
    } catch {
      throw new Error('Extra Appium capabilities must be a JSON object');
    }
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))
      throw new Error('Extra Appium capabilities must be a JSON object');
  }
  const t = (s: string) => s.trim() || undefined;
  return {
    app: t(f.app),
    appPackage: t(f.appPackage),
    appActivity: t(f.appActivity),
    avd: t(f.avd),
    udid: t(f.udid),
    resetApp: f.resetApp,
    showEmulator: f.showEmulator,
    capabilities,
  };
}
export const androidLaunchSet = (f: AndroidForm) => !!(f.app.trim() || f.appPackage.trim());

/** How an environment starts an Android app: the app, the device, and per-test options. */
export function AndroidLaunchFields({
  value: f,
  onChange,
}: {
  value: AndroidForm;
  onChange: (f: AndroidForm) => void;
}) {
  const status = useNativeStatus();
  const set = (p: Partial<AndroidForm>) => onChange({ ...f, ...p });
  const phones = status.data?.devices.filter((d) => !d.emulator) ?? [];
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Start the Android app</p>
      <p className="text-xs text-muted">
        The app file (.apk) is installed on the device for each test, or name an app already installed.
        Variables work here: {'{{env.apkPath}}'}.
      </p>
      <Field label="App file (.apk)">
        <Input
          aria-label="App file"
          value={f.app}
          className="font-mono text-xs"
          placeholder="/Users/me/builds/app-debug.apk"
          onChange={(e) => set({ app: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="or installed app’s package">
          <Input
            aria-label="App package"
            value={f.appPackage}
            className="font-mono text-xs"
            placeholder="com.example.app"
            onChange={(e) => set({ appPackage: e.target.value })}
          />
        </Field>
        <Field label="Start screen (activity)" hint="Optional.">
          <Input
            aria-label="App activity"
            value={f.appActivity}
            className="font-mono text-xs"
            placeholder=".MainActivity"
            onChange={(e) => set({ appActivity: e.target.value })}
          />
        </Field>
        <Field label="Emulator" hint="Started when a test needs it.">
          <Select aria-label="Emulator" value={f.avd} onChange={(e) => set({ avd: e.target.value })}>
            <option value="">— none (use a phone) —</option>
            {[...new Set([...(status.data?.avds ?? []), ...(f.avd ? [f.avd] : [])])].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Phone or device serial" hint="Empty: the only connected device.">
          <Input
            aria-label="Device serial"
            value={f.udid}
            list="android-devices"
            className="font-mono text-xs"
            placeholder={phones[0]?.serial ?? 'R58N12ABCDE'}
            onChange={(e) => set({ udid: e.target.value })}
          />
          <datalist id="android-devices">
            {status.data?.devices.map((d) => (
              <option key={d.serial} value={d.serial}>
                {d.model ?? d.serial} ({d.state})
              </option>
            ))}
          </datalist>
        </Field>
      </div>
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2">
          <Switch
            checked={f.resetApp}
            onChange={(resetApp) => set({ resetApp })}
            label="Reset the app before each test"
          />
          Reset the app’s data before each test
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={f.showEmulator}
            onChange={(showEmulator) => set({ showEmulator })}
            label="Show the emulator window"
          />
          Show the emulator window
        </label>
      </div>
      <Field label="Extra Appium capabilities" hint='Optional JSON, e.g. { "appium:language": "fr" }.'>
        <Textarea
          aria-label="Extra Appium capabilities"
          value={f.capabilities}
          rows={2}
          className="font-mono text-xs"
          onChange={(e) => set({ capabilities: e.target.value })}
        />
      </Field>
      {!androidLaunchSet(f) && (
        <p className="text-xs text-fail">Set the app file or the installed app’s package.</p>
      )}
    </div>
  );
}

/** What this computer has for Android testing, with how to fix what is missing, and installing Appium. */
export function AndroidStatusCard() {
  const status = useNativeStatus();
  const qc = useQueryClient();
  const install = useMutation({
    mutationFn: () => api<NativeStatus>('/api/native/appium/install', { method: 'POST' }),
    onSuccess: (s) => {
      qc.setQueryData(STATUS_KEY, s);
      toast('Appium is installed');
    },
    onError: toastError,
  });
  if (!status.data) return null;
  const appiumMissing = status.data.checks.some((c) => c.name.startsWith('Appium') && !c.ok);
  return (
    <section aria-label="Android on this computer" className="rounded-lg border border-border p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Android on this computer{' '}
          <span className={status.data.ready ? 'text-pass' : 'text-warn'}>
            {status.data.ready ? '— ready' : '— needs setting up'}
          </span>
        </p>
        {appiumMissing && (
          <Button size="sm" disabled={install.isPending} onClick={() => install.mutate()}>
            <Download className="h-3.5 w-3.5" /> {install.isPending ? 'Installing Appium…' : 'Install Appium'}
          </Button>
        )}
      </div>
      <ul className="space-y-1 text-xs">
        {status.data.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-2">
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pass" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fail" />
            )}
            <span>
              <span className="font-medium">{c.name}</span> · <span className="text-muted">{c.detail}</span>
              {!c.ok && c.fix && <span className="block text-muted">→ {c.fix}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
