import { createServer, type Server } from 'node:http';
import { PNG } from 'pngjs';

/**
 * A fake Appium server for tests of StepForge itself (no device needed): it answers the WebDriver commands the native
 * executor sends, as UiAutomator2 (Android) or Mac2 (macOS) would, for a small sign-in screen. Taps and clicks change
 * the screen's colour, so a test can see an action arrive; typing goes into the focused field.
 */
export type FakeElement = {
  id: string;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  field?: boolean;
};

export type FakeAppium = {
  url: string;
  /** Every command received: method, path and body. */
  calls: { method: string; path: string; body: Record<string, unknown> }[];
  /** What was typed into each field. */
  typed: Record<string, string>;
  /** The colour of the screen (changes with each tap or click). */
  tapped: number;
  quits: number;
  close(): Promise<void>;
};

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

function picture(width: number, height: number, shade: number): string {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (shade * 40) % 256;
    img.data[i + 1] = 120;
    img.data[i + 2] = 200;
    img.data[i + 3] = 255;
  }
  return PNG.sync.write(img).toString('base64');
}

export async function startFakeAppium(port = 0): Promise<FakeAppium> {
  const state = {
    calls: [] as FakeAppium['calls'],
    typed: {} as Record<string, string>,
    tapped: 0,
    quits: 0,
  };
  let platform: 'android' | 'mac' = 'android';
  let focused: string | undefined;
  const android: FakeElement[] = [
    {
      id: 'email',
      tag: 'android.widget.EditText',
      text: '',
      field: true,
      rect: { x: 60, y: 200, width: 960, height: 100 },
    },
    {
      id: 'sign_in',
      tag: 'android.widget.Button',
      text: 'Sign in',
      rect: { x: 60, y: 400, width: 960, height: 140 },
    },
  ];
  const mac: FakeElement[] = [
    {
      id: 'email',
      tag: 'XCUIElementTypeTextField',
      text: '',
      field: true,
      rect: { x: 220, y: 130, width: 360, height: 24 },
    },
    {
      id: '',
      tag: 'XCUIElementTypeButton',
      text: 'Sign in',
      rect: { x: 220, y: 200, width: 100, height: 30 },
    },
  ];
  const elements = () => (platform === 'mac' ? mac : android);
  const ref = (e: FakeElement) => `el-${elements().indexOf(e)}`;
  const byRef = (r: string) => elements()[Number(r.replace('el-', ''))];
  const source = () => {
    if (platform === 'mac')
      return `<XCUIElementTypeApplication elementType="2" identifier="" title="CareClinic" x="0" y="0" width="0" height="0">
<XCUIElementTypeWindow elementType="4" identifier="" title="CareClinic" x="200" y="100" width="400" height="300">
${mac.map((e) => `<${e.tag} elementType="9" identifier="${e.id}" label="" title="${e.text}" value="${state.typed[e.id] ?? ''}" placeholderValue="${e.field ? 'Email' : ''}" x="${e.rect.x}" y="${e.rect.y}" width="${e.rect.width}" height="${e.rect.height}"/>`).join('\n')}
</XCUIElementTypeWindow></XCUIElementTypeApplication>`;
    return `<hierarchy width="1080" height="1920"><android.widget.FrameLayout class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">
${android.map((e) => `<${e.tag} class="${e.tag}" resource-id="com.stepforge.careclinic:id/${e.id}" text="${e.field ? (state.typed[e.id] ?? '') : e.text}" hint="${e.field ? 'Email' : ''}" clickable="true" bounds="[${e.rect.x},${e.rect.y}][${e.rect.x + e.rect.width},${e.rect.y + e.rect.height}]"/>`).join('\n')}
</android.widget.FrameLayout></hierarchy>`;
  };
  const find = (using: string, value: string) =>
    elements().filter((e) =>
      using === 'id' || using === 'accessibility id'
        ? !!e.id && (value === e.id || value.endsWith(`:id/${e.id}`))
        : (!!e.id && value.includes(`'${e.id}'`)) ||
          (!!e.id && value.includes(`"${e.id}"`)) ||
          (!!e.text && value.includes(e.text)) ||
          (e.field && value.includes('Email')),
    );

  const answer = (method: string, parts: string[], body: Record<string, unknown>): unknown => {
    if (parts[0] === 'status') return { ready: true };
    if (parts.length === 1 && parts[0] === 'session' && method === 'POST') {
      const caps = ((body.capabilities as { alwaysMatch?: Record<string, unknown> })?.alwaysMatch ??
        {}) as Record<string, unknown>;
      platform = String(caps.platformName).toLowerCase() === 'mac' ? 'mac' : 'android';
      state.typed = {};
      focused = undefined;
      return {
        sessionId: 'fake-session',
        capabilities: { ...caps, deviceModel: 'fake_phone' },
      };
    }
    const rest = parts.slice(2);
    const cmd = rest.join('/');
    if (!rest.length && method === 'DELETE') {
      state.quits++;
      return null;
    }
    if (cmd === 'screenshot')
      return platform === 'mac' ? picture(1440, 900, state.tapped) : picture(1080, 1920, state.tapped);
    if (cmd === 'source') return source();
    if (cmd === 'window/rect')
      return platform === 'mac'
        ? { x: 0, y: 0, width: 1440, height: 900 }
        : { x: 0, y: 0, width: 1080, height: 1794 };
    if (cmd === 'elements')
      return find(String(body.using), String(body.value)).map((e) => ({ [ELEMENT]: ref(e) }));
    if (cmd === 'element/active') return focused ? { [ELEMENT]: focused } : null;
    if (rest[0] === 'element' && rest[1]) {
      const e = byRef(rest[1]);
      if (!e) throw Object.assign(new Error('no such element'), { error: 'no such element' });
      switch (rest[2]) {
        case 'rect':
          return e.rect;
        case 'click':
          state.tapped++;
          if (e.field) focused = rest[1];
          return null;
        case 'clear':
          state.typed[e.id] = '';
          return null;
        case 'value':
          state.typed[e.id] = (state.typed[e.id] ?? '') + String(body.text ?? '');
          return null;
        case 'text':
          return e.field ? (state.typed[e.id] ?? '') : e.text;
        case 'displayed':
        case 'enabled':
          return true;
        case 'screenshot':
          return picture(e.rect.width, e.rect.height, state.tapped);
      }
    }
    if (cmd === 'actions') {
      // A tap or click at a point: the field under it gets the focus.
      const acts =
        (body.actions as { type: string; actions: { type: string; x?: number; y?: number }[] }[]) ?? [];
      for (const a of acts) {
        if (a.type === 'key') {
          const text = a.actions
            .filter((k) => k.type === 'keyDown')
            .map((k) => (k as { value?: string }).value)
            .join('');
          // A shortcut (a modifier held) types nothing.
          if (focused && !/[\uE000-\uF8FF]/.test(text))
            state.typed[byRef(focused)!.id] = (state.typed[byRef(focused)!.id] ?? '') + text;
          continue;
        }
        const move = a.actions.find((p) => p.type === 'pointerMove');
        if (!move) continue;
        state.tapped++;
        const hit = elements().find(
          (e) =>
            move.x! >= e.rect.x &&
            move.x! <= e.rect.x + e.rect.width &&
            move.y! >= e.rect.y &&
            move.y! <= e.rect.y + e.rect.height,
        );
        focused = hit?.field ? ref(hit) : undefined;
      }
      return null;
    }
    if (cmd === 'execute/sync') {
      const script = String(body.script);
      if (script === 'mobile: getSystemBars') return { statusBar: { height: 0 } };
      if (script === 'macos: click') {
        state.tapped++;
        return null;
      }
      return null;
    }
    if (cmd === 'appium/start_recording_screen') return null;
    // A recording is "made": a few bytes stand for the MP4.
    if (cmd === 'appium/stop_recording_screen') return Buffer.from('fake mp4').toString('base64');
    if (cmd === 'se/log') return [];
    if (cmd === 'alert/text') throw Object.assign(new Error('no alert'), { error: 'no such alert' });
    throw Object.assign(new Error(`Not faked: ${method} /${cmd}`), { error: 'unknown command' });
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      const path = (req.url ?? '/').split('?')[0]!;
      state.calls.push({ method: req.method ?? 'GET', path, body });
      const parts = path.split('/').filter(Boolean);
      try {
        const value = answer(req.method ?? 'GET', parts, body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: value ?? null }));
      } catch (err) {
        const e = err as Error & { error?: string };
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ value: { error: e.error ?? 'unknown error', message: e.message } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    get calls() {
      return state.calls;
    },
    get typed() {
      return state.typed;
    },
    get tapped() {
      return state.tapped;
    },
    get quits() {
      return state.quits;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
