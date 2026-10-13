import { useState } from 'react';
import { Field, Input, Select, Textarea } from '@/components/ui/input';

/** An environment's browser settings as form text (blank = browser default). */
export type BrowserSettingsForm = {
  channel: string;
  locale: string;
  timezoneId: string;
  colorScheme: string;
  latitude: string;
  longitude: string;
  permissions: string;
  userAgent: string;
  headers: string;
  basicUser: string;
  basicPassword: string;
  proxy: string;
  certOrigin: string;
  certPath: string;
  keyPath: string;
  pfxPath: string;
  passphrase: string;
  serviceWorkers: string;
};

type Settings = Record<string, unknown> & {
  geolocation?: { latitude: number; longitude: number };
  permissions?: string[];
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string };
  proxy?: { server: string };
  clientCertificates?: {
    origin: string;
    certPath?: string;
    keyPath?: string;
    pfxPath?: string;
    passphrase?: string;
  }[];
};

export function settingsToForm(raw: unknown): BrowserSettingsForm {
  const s = (raw ?? {}) as Settings;
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const cert = s.clientCertificates?.[0];
  return {
    channel: str(s.channel),
    locale: str(s.locale),
    timezoneId: str(s.timezoneId),
    colorScheme: str(s.colorScheme),
    latitude: str(s.geolocation?.latitude),
    longitude: str(s.geolocation?.longitude),
    permissions: (s.permissions ?? []).join(', '),
    userAgent: str(s.userAgent),
    headers: Object.entries(s.extraHTTPHeaders ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    basicUser: str(s.httpCredentials?.username),
    basicPassword: str(s.httpCredentials?.password),
    proxy: str(s.proxy?.server),
    certOrigin: str(cert?.origin),
    certPath: str(cert?.certPath),
    keyPath: str(cert?.keyPath),
    pfxPath: str(cert?.pfxPath),
    passphrase: str(cert?.passphrase),
    serviceWorkers: str(s.serviceWorkers),
  };
}

/** Only what is filled in is sent; the server checks the values. */
export function formToSettings(f: BrowserSettingsForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, v: string) => {
    if (v.trim()) out[key] = v.trim();
  };
  put('channel', f.channel);
  put('locale', f.locale);
  put('timezoneId', f.timezoneId);
  put('colorScheme', f.colorScheme);
  put('userAgent', f.userAgent);
  put('serviceWorkers', f.serviceWorkers);
  if (f.latitude.trim() && f.longitude.trim())
    out.geolocation = { latitude: Number(f.latitude), longitude: Number(f.longitude) };
  const permissions = f.permissions
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (permissions.length) out.permissions = permissions;
  const headers = Object.fromEntries(
    f.headers
      .split('\n')
      .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
      .filter(([k, v]) => k && v !== undefined),
  );
  if (Object.keys(headers).length) out.extraHTTPHeaders = headers;
  if (f.basicUser.trim()) out.httpCredentials = { username: f.basicUser.trim(), password: f.basicPassword };
  if (f.proxy.trim()) out.proxy = { server: f.proxy.trim() };
  if (f.certOrigin.trim())
    out.clientCertificates = [
      Object.fromEntries(
        Object.entries({
          origin: f.certOrigin.trim(),
          certPath: f.certPath.trim(),
          keyPath: f.keyPath.trim(),
          pfxPath: f.pfxPath.trim(),
          passphrase: f.passphrase,
        }).filter(([, v]) => v),
      ),
    ];
  return out;
}

/**
 * Browser settings of an environment: what a site needs to open the way users see it — language, time zone, location,
 * dark mode, a login for HTTP basic auth, extra headers, a proxy, a client certificate, Chrome or Edge.
 */
export function BrowserSettingsFields({
  value,
  onChange,
}: {
  value: BrowserSettingsForm;
  onChange: (v: BrowserSettingsForm) => void;
}) {
  const filled = Object.values(value).filter((v) => v.trim()).length;
  const [open, setOpen] = useState(filled > 0);
  const set = (p: Partial<BrowserSettingsForm>) => onChange({ ...value, ...p });
  const text = (key: keyof BrowserSettingsForm, label: string, placeholder?: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        aria-label={label}
        value={value[key]}
        placeholder={placeholder}
        onChange={(e) => set({ [key]: e.target.value })}
      />
    </Field>
  );
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Browser settings{filled ? ` (${filled} set)` : ''}
        <span className="text-xs font-normal text-muted">
          Language, time zone, location, basic auth, headers, proxy, certificates
        </span>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-3 border-t border-border p-3">
          <Field label="Browser build" hint="Chrome or Edge must be installed on this computer">
            <Select
              aria-label="Browser build"
              value={value.channel}
              onChange={(e) => set({ channel: e.target.value })}
            >
              <option value="">Bundled browser</option>
              <option value="chrome">Google Chrome (installed)</option>
              <option value="msedge">Microsoft Edge (installed)</option>
            </Select>
          </Field>
          <Field label="Colour scheme">
            <Select
              aria-label="Colour scheme"
              value={value.colorScheme}
              onChange={(e) => set({ colorScheme: e.target.value })}
            >
              <option value="">Default</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </Field>
          {text('locale', 'Language', 'de-DE')}
          {text('timezoneId', 'Time zone', 'Europe/Berlin')}
          {text('latitude', 'Latitude', '52.52', 'Location for maps and “near me” features')}
          {text('longitude', 'Longitude', '13.40')}
          {text('permissions', 'Permissions granted', 'geolocation, notifications, clipboard-read')}
          {text('userAgent', 'User agent', 'Leave empty for the browser’s own')}
          {text('basicUser', 'Basic auth user', '', 'For sites behind an HTTP login prompt')}
          {text(
            'basicPassword',
            'Basic auth password',
            '{{secret.basicPassword}}',
            'Use a secret placeholder',
          )}
          <Field
            label="Extra headers"
            className="col-span-2"
            hint="One per line: Name: value (secrets allowed)"
          >
            <Textarea
              aria-label="Extra headers"
              rows={2}
              className="font-mono text-xs"
              value={value.headers}
              placeholder="X-Feature-Flags: new-checkout"
              onChange={(e) => set({ headers: e.target.value })}
            />
          </Field>
          {text('proxy', 'Proxy', 'http://proxy.local:3128')}
          <Field label="Service workers">
            <Select
              aria-label="Service workers"
              value={value.serviceWorkers}
              onChange={(e) => set({ serviceWorkers: e.target.value })}
            >
              <option value="">Allowed</option>
              <option value="block">Blocked (no offline cache)</option>
            </Select>
          </Field>
          {text(
            'certOrigin',
            'Client certificate for',
            'https://intranet.example.com',
            'Sites that ask for a certificate (mTLS)',
          )}
          {text('pfxPath', 'Certificate file (.pfx/.p12)', '/path/to/cert.pfx')}
          {text('certPath', 'or certificate (.pem)', '/path/to/cert.pem')}
          {text('keyPath', 'and key (.pem)', '/path/to/key.pem')}
          {text('passphrase', 'Certificate passphrase', '{{secret.certPass}}')}
        </div>
      )}
    </div>
  );
}
