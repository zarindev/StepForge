import { StepError, type Locator, type StepInput } from '@stepforge/core';
import type { Direction, NativePlatform } from './platforms.ts';
import { linuxNamed, xpathLiteral } from './locators.ts';
import { pngSize, type Area } from './view.ts';
import { WebDriverSession, type ElementRef } from './webdriver.ts';

export type NativeRecordedStep = StepInput & { id: number; describe?: string };
export type NativeRecorderSnapshot = {
  state: 'recording' | 'stopped';
  startUrl: string;
  steps: NativeRecordedStep[];
  network: never[];
  secretKeys: string[];
  native: { platform: string };
};

/** An element of the screen, from the app's element tree. */
export type ScreenElement = {
  attrs: Record<string, string>;
  /**
   * In the element tree's coordinates: pixels on Android, points on iOS and macOS (the main display's), the app
   * window's pixels on Windows, the screen's pixels on Linux.
   */
  rect: { x: number; y: number; width: number; height: number };
  depth: number;
};

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#10;/g, '\n')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

/** Every element of an Appium page source (Android or iOS), with its bounds. */
export function parseElements(xml: string): ScreenElement[] {
  const out: ScreenElement[] = [];
  let depth = 0;
  for (const m of xml.matchAll(/<(\/?)([\w.$]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, closing, tag, rawAttrs = '', selfClosing] = m;
    if (closing) {
      depth--;
      continue;
    }
    const attrs: Record<string, string> = { tag: tag! };
    for (const a of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = decode(a[2]!);
    let rect: ScreenElement['rect'] | undefined;
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? '');
    if (b) {
      const [x1, y1, x2, y2] = b.slice(1).map(Number) as [number, number, number, number];
      rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    } else if (attrs.width !== undefined) {
      rect = {
        x: Number(attrs.x),
        y: Number(attrs.y),
        width: Number(attrs.width),
        height: Number(attrs.height),
      };
    }
    if (rect && tag !== 'hierarchy' && tag !== 'AppiumAUT' && tag !== 'application')
      out.push({ attrs, rect, depth });
    if (!selfClosing) depth++;
  }
  return out;
}

type Kind = NativePlatform['name'];

/**
 * Which app an element comes from, by its element tree: Android (bounds), macOS (Mac2: XCUIElementType tags with an
 * identifier), iOS (XCUIElementType tags with a name), Windows (UI Automation's AutomationId), Linux (the helper).
 */
export function kindOf(e: ScreenElement): Kind {
  const a = e.attrs;
  if (a.bounds !== undefined) return 'Android';
  if (a.tag?.startsWith('XCUIElementType'))
    return a.elementType !== undefined || (a.identifier !== undefined && a.type === undefined)
      ? 'macOS'
      : 'iOS';
  if (a.AutomationId !== undefined || a.ControlType !== undefined || a.LocalizedControlType !== undefined)
    return 'Windows';
  return 'Linux';
}
const typeOf = (e: ScreenElement) => e.attrs.type ?? e.attrs.class ?? e.attrs.tag ?? '';
const FIELD =
  /EditText|TextField|SecureTextField|TextView$|SearchField|AutoCompleteTextView|XCUIElementTypeComboBox|^Edit$|^(text|entry|password_text)$/;
export const isField = (e: ScreenElement) =>
  FIELD.test(typeOf(e)) && !/StaticText/.test(typeOf(e)) && typeOf(e) !== 'android.widget.TextView';
const isSecret = (e: ScreenElement) =>
  e.attrs.password === 'true' ||
  e.attrs.IsPassword === 'True' ||
  /SecureTextField|^password_text$/.test(typeOf(e));

/** Worth recording on its own: something a user taps or reads, not a layout container. */
function meaningful(e: ScreenElement): boolean {
  const a = e.attrs;
  switch (kindOf(e)) {
    case 'Android':
      return (
        a.clickable === 'true' || !!a.text || !!a['content-desc'] || /:id\//.test(a['resource-id'] ?? '')
      );
    case 'iOS':
      return (
        !/XCUIElementType(Other|Window|Application|ScrollView|Table|CollectionView)$/.test(typeOf(e)) ||
        !!a.name
      );
    case 'macOS':
      return (
        !/XCUIElementType(Other|Window|Application|ScrollView|Table|Outline|CollectionView|Group|SplitGroup|LayoutArea|Toolbar|Sheet|Unknown)$/.test(
          typeOf(e),
        ) || !!a.identifier
      );
    case 'Windows':
      return !/^(Pane|Window|Group|Custom|TitleBar|ScrollBar)$/.test(typeOf(e)) || !!a.AutomationId;
    case 'Linux':
      return (
        !/^(filler|panel|frame|scroll_pane|viewport|window|dialog|layered_pane|unknown|redundant_object)$/.test(
          typeOf(e),
        ) || !!a.id
      );
  }
}

/** The element under a point: the smallest meaningful one that contains it (else the smallest of all). */
export function elementAt(elements: ScreenElement[], x: number, y: number): ScreenElement | undefined {
  const hits = elements.filter(
    (e) =>
      e.rect.width > 0 &&
      e.rect.height > 0 &&
      x >= e.rect.x &&
      y >= e.rect.y &&
      x <= e.rect.x + e.rect.width &&
      y <= e.rect.y + e.rect.height &&
      e.attrs.visible !== 'false' &&
      e.attrs.IsOffscreen !== 'True',
  );
  const area = (e: ScreenElement) => e.rect.width * e.rect.height;
  const byArea = (a: ScreenElement, b: ScreenElement) => area(a) - area(b) || b.depth - a.depth;
  return hits.filter(meaningful).sort(byArea)[0] ?? hits.sort(byArea)[0];
}

const IOS_ROLES: Record<string, string> = {
  XCUIElementTypeButton: 'button',
  XCUIElementTypeTextField: 'textbox',
  XCUIElementTypeSecureTextField: 'textbox',
  XCUIElementTypeSwitch: 'switch',
  XCUIElementTypeStaticText: 'text',
  XCUIElementTypeLink: 'link',
  XCUIElementTypeImage: 'img',
};
const ANDROID_ROLES: Record<string, string> = {
  'android.widget.Button': 'button',
  'android.widget.ImageButton': 'button',
  'android.widget.EditText': 'textbox',
  'android.widget.CheckBox': 'checkbox',
  'android.widget.Switch': 'switch',
  'android.widget.RadioButton': 'radio',
  'android.widget.Spinner': 'combobox',
  'android.widget.ImageView': 'img',
};

const MAC_ROLES: Record<string, string> = {
  XCUIElementTypeButton: 'button',
  XCUIElementTypeCheckBox: 'checkbox',
  XCUIElementTypeRadioButton: 'radio',
  XCUIElementTypePopUpButton: 'combobox',
  XCUIElementTypeMenuItem: 'menuitem',
  XCUIElementTypeMenuBarItem: 'menuitem',
  XCUIElementTypeStaticText: 'text',
  XCUIElementTypeLink: 'link',
  XCUIElementTypeImage: 'img',
  XCUIElementTypeSlider: 'slider',
};
const WINDOWS_ROLES: Record<string, string> = {
  Button: 'button',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  ComboBox: 'combobox',
  MenuItem: 'menuitem',
  Hyperlink: 'link',
  Text: 'text',
  ListItem: 'listitem',
  TabItem: 'tab',
  Image: 'img',
  Slider: 'slider',
};
const LINUX_ROLES: Record<string, string> = {
  push_button: 'button',
  toggle_button: 'button',
  check_box: 'checkbox',
  radio_button: 'radio',
  combo_box: 'combobox',
  menu_item: 'menuitem',
  menu: 'menuitem',
  label: 'text',
  link: 'link',
  page_tab: 'tab',
  slider: 'slider',
};

/** Locators of a desktop app's element: the same strategies the desktop queries (locators.ts) look up. */
function desktopLocators(e: ScreenElement, kind: 'macOS' | 'Windows' | 'Linux'): Locator[] {
  const a = e.attrs;
  const tag = a.tag ?? '*';
  const field = isField(e);
  const out: Locator[] = [];
  if (kind === 'macOS') {
    // Buttons show their title; static texts their value.
    const text = a.title || a.label || (tag === 'XCUIElementTypeStaticText' ? a.value : '') || '';
    if (a.identifier) out.push({ strategy: 'testId', value: a.identifier, score: 95 });
    if (field && a.placeholderValue)
      out.push({ strategy: 'placeholder', value: a.placeholderValue, score: 85 });
    const role = MAC_ROLES[tag];
    if (role && !field && text) out.push({ strategy: 'role', value: role, name: text, score: 80 });
    if (!field && text) out.push({ strategy: 'text', value: text, score: 70 });
    const attr = a.identifier
      ? `@identifier=${xpathLiteral(a.identifier)}`
      : a.title
        ? `@title=${xpathLiteral(a.title)}`
        : a.label
          ? `@label=${xpathLiteral(a.label)}`
          : field && a.placeholderValue
            ? `@placeholderValue=${xpathLiteral(a.placeholderValue)}`
            : '';
    if (attr) out.push({ strategy: 'xpath', value: `//${tag}[${attr}]`, score: 30 });
    return out;
  }
  // Windows (UI Automation) and Linux (AT-SPI): an id, and a name (a field's name is its label).
  const id = kind === 'Windows' ? a.AutomationId : a.id;
  const name = (kind === 'Windows' ? a.Name : a.name) ?? '';
  if (id) out.push({ strategy: 'testId', value: id, score: 95 });
  if (field && name) out.push({ strategy: 'label', value: name, score: 85 });
  const role = (kind === 'Windows' ? WINDOWS_ROLES : LINUX_ROLES)[tag];
  if (role && !field && name) out.push({ strategy: 'role', value: role, name, score: 80 });
  if (!field && name) out.push({ strategy: 'text', value: name, score: 70 });
  if (kind === 'Windows') {
    const attr = id ? `@AutomationId=${xpathLiteral(id)}` : name ? `@Name=${xpathLiteral(name)}` : '';
    if (attr) out.push({ strategy: 'xpath', value: `//${tag}[${attr}]`, score: 30 });
  } else if (id && !(id.includes("'") && id.includes('"'))) {
    out.push({ strategy: 'xpath', value: `//${tag}[@id=${xpathLiteral(id)}]`, score: 30 });
  } else if (name) {
    // ElementTree's XPath has no concat(): a name with both quotes has no XPath.
    const q = linuxNamed(tag, name);
    if (q.using === 'xpath') out.push({ strategy: 'xpath', value: q.value, score: 30 });
  }
  return out;
}

/** Ranked locators for an element, best first (they are checked against the app before use). */
export function locatorsFor(e: ScreenElement, kind: Kind = kindOf(e)): Locator[] {
  const a = e.attrs;
  const out: Locator[] = [];
  const field = isField(e);
  if (kind === 'macOS' || kind === 'Windows' || kind === 'Linux') return desktopLocators(e, kind);
  if (kind === 'Android') {
    const id = /:id\/(.+)$/.exec(a['resource-id'] ?? '')?.[1];
    if (id) out.push({ strategy: 'testId', value: id, score: 95 });
    if (a['content-desc']) out.push({ strategy: 'label', value: a['content-desc'], score: 90 });
    if (field && a.hint) out.push({ strategy: 'placeholder', value: a.hint, score: 85 });
    const role = ANDROID_ROLES[a.class ?? ''];
    if (role && !field && a.text) out.push({ strategy: 'role', value: role, name: a.text, score: 80 });
    if (!field && a.text) out.push({ strategy: 'text', value: a.text, score: 70 });
    const attr = id
      ? `@resource-id=${xpathLiteral(a['resource-id']!)}`
      : a['content-desc']
        ? `@content-desc=${xpathLiteral(a['content-desc'])}`
        : !field && a.text
          ? `@text=${xpathLiteral(a.text)}`
          : field && a.hint
            ? `@hint=${xpathLiteral(a.hint)}`
            : '';
    if (attr) out.push({ strategy: 'xpath', value: `//${a.class ?? '*'}[${attr}]`, score: 30 });
  } else {
    // `name` is the accessibility identifier when one is set, else it repeats the label.
    const identifier = a.name && a.name !== a.label ? a.name : undefined;
    if (identifier) out.push({ strategy: 'testId', value: identifier, score: 95 });
    if (field && a.placeholderValue)
      out.push({ strategy: 'placeholder', value: a.placeholderValue, score: 85 });
    const role = IOS_ROLES[a.type ?? ''];
    if (role && !field && a.label) out.push({ strategy: 'role', value: role, name: a.label, score: 80 });
    if (!field && a.label) out.push({ strategy: 'text', value: a.label, score: 70 });
    const attr = a.name ? `@name=${xpathLiteral(a.name)}` : a.label ? `@label=${xpathLiteral(a.label)}` : '';
    if (attr) out.push({ strategy: 'xpath', value: `//${a.type ?? '*'}[${attr}]`, score: 30 });
  }
  return out;
}

const describeEl = (e: ScreenElement) => {
  const a = e.attrs;
  const name =
    a.text ||
    a.label ||
    a.title ||
    a['content-desc'] ||
    a.hint ||
    a.placeholderValue ||
    a.name ||
    a.Name ||
    (a.tag === 'XCUIElementTypeStaticText' ? a.value : '') ||
    '';
  const kind = (typeOf(e).split('.').pop() ?? '').replace('XCUIElementType', '');
  return name ? `${kind} "${name}"` : kind;
};

const camel = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^./, (c) => c.toLowerCase()) || 'password';

/**
 * Recording a phone or desktop app: the dashboard shows the screen (a desktop app's windows); a tap or click, typing,
 * a swipe, a key, a menu or a check there is done in the app and becomes a step, with locators taken from the element
 * tree. Same snapshot shape as the browser recorder, so review and save work the same way.
 */
export class NativeRecordingSession {
  state: 'recording' | 'stopped' = 'recording';
  readonly secrets: Record<string, string> = {};
  private steps: NativeRecordedStep[] = [];
  private nextId = 1;
  private lastField?: { locators: Locator[]; secret: boolean; step?: NativeRecordedStep };
  private busy: Promise<unknown> = Promise.resolve();
  /** What the dashboard's picture shows, in the element tree's coordinates (from the last picture). */
  private area?: Area;

  private constructor(
    private readonly driver: WebDriverSession,
    private readonly platform: NativePlatform,
    private readonly opts: {
      startUrl: string;
      onChange?: (s: NativeRecorderSnapshot) => void;
      onStop?: (s: NativeRecorderSnapshot) => void;
    },
  ) {}

  static async start(opts: {
    appiumUrl: string;
    platform: NativePlatform;
    startUrl: string;
    onChange?: (s: NativeRecorderSnapshot) => void;
    onStop?: (s: NativeRecorderSnapshot) => void;
  }): Promise<NativeRecordingSession> {
    let driver: WebDriverSession;
    try {
      driver = await WebDriverSession.create(opts.appiumUrl, opts.platform.capabilities(), 900_000);
    } catch (err) {
      if (err instanceof StepError) throw err;
      throw new StepError(
        'navigation',
        `The ${opts.platform.name} app did not start: ${(err as Error).message}`,
      );
    }
    return new NativeRecordingSession(driver, opts.platform, opts);
  }

  snapshot(): NativeRecorderSnapshot {
    return {
      state: this.state,
      startUrl: this.opts.startUrl,
      steps: this.steps.map((s) => ({ ...s })),
      network: [],
      secretKeys: Object.keys(this.secrets),
      native: { platform: this.platform.name },
    };
  }

  private changed(): void {
    this.opts.onChange?.(this.snapshot());
  }

  private push(step: Omit<NativeRecordedStep, 'id'>): NativeRecordedStep {
    const s = { ...step, id: this.nextId++ } as NativeRecordedStep;
    this.steps.push(s);
    this.changed();
    return s;
  }

  /** One action at a time, in order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state !== 'recording')
      return Promise.reject(new StepError('invalid_params', 'The recording has stopped'));
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  /** The screen (a desktop app's windows) as a PNG, and its size in pixels. */
  async screen(): Promise<{ png: Buffer; width: number; height: number }> {
    const { png, area } = await this.platform.view(this.driver);
    this.area = area;
    return { png, ...pngSize(png) };
  }

  /**
   * What the screen fractions are fractions of, in the element tree's coordinates: the part the last picture showed.
   * Android's tree is in the screenshot's pixels (the window size leaves out the status and navigation bars); iOS's
   * and macOS's in points (a Retina picture has more pixels: fractions need no scale); a desktop picture shows only
   * the app's windows.
   */
  private async screenArea(): Promise<Area> {
    if (!this.area) await this.screen();
    return this.area!;
  }

  /** Clicked or tapped, by the platform's words. */
  private get verb() {
    return this.platform.kind === 'desktop' ? 'Click' : 'Tap';
  }

  /** The element at a point given as fractions of the screen (0–1), with its ranked, checked locators. */
  async inspect(
    fx: number,
    fy: number,
  ): Promise<{ element: ScreenElement; locators: Locator[]; describe: string } | null> {
    const hit = await this.at(fx, fy);
    return hit && { element: hit.element, locators: hit.locators, describe: hit.describe };
  }

  /**
   * The element at a point, its locators and a reference to it. A locator is kept only when it finds that one
   * element and nothing else (a list repeats ids and texts: its first match is another row); failing all, the
   * element's XPath with its position among the matches.
   */
  private async at(fx: number, fy: number) {
    const [source, area] = await Promise.all([this.driver.source(), this.screenArea()]);
    const element = elementAt(parseElements(source), area.x + fx * area.width, area.y + fy * area.height);
    if (!element) return null;
    const same = (r: ScreenElement['rect']) =>
      Math.abs(r.x - element.rect.x) <= 1 &&
      Math.abs(r.y - element.rect.y) <= 1 &&
      Math.abs(r.width - element.rect.width) <= 1 &&
      Math.abs(r.height - element.rect.height) <= 1;
    const rectOf = (el: ElementRef) => this.driver.rect(el).catch(() => undefined);
    const candidates = locatorsFor(element, this.platform.name);
    const locators: Locator[] = [];
    let el: ElementRef | undefined;
    for (const l of candidates) {
      // As a test finds it: the first query with matches, its first match.
      const els = await this.matches(l);
      if (els.length !== 1) continue;
      const r = await rectOf(els[0]!);
      if (!r || !same(r)) continue;
      locators.push(l);
      el ??= els[0];
    }
    const xpath = candidates.find((l) => l.strategy === 'xpath');
    if (!locators.length && xpath) {
      const els = await this.driver.findAll('xpath', xpath.value).catch(() => [] as ElementRef[]);
      for (const [i, ref] of els.entries()) {
        const r = await rectOf(ref);
        if (r && same(r)) {
          locators.push({ strategy: 'xpath', value: `(${xpath.value})[${i + 1}]`, score: 20 });
          el = ref;
          break;
        }
      }
    }
    return { element, locators, describe: describeEl(element), el };
  }

  /** Where an element is, as fractions of the screen (its centre), e.g. to tap it from a test. */
  async pointOf(locators: Locator[]): Promise<{ x: number; y: number } | null> {
    const el = await this.find(locators);
    if (!el) return null;
    const [r, area] = await Promise.all([this.driver.rect(el), this.screenArea()]);
    return {
      x: (r.x + r.width / 2 - area.x) / area.width,
      y: (r.y + r.height / 2 - area.y) / area.height,
    };
  }

  /** What a locator's first query with any matches finds. */
  private async matches(l: Locator): Promise<ElementRef[]> {
    for (const q of this.platform.queries(l)) {
      const els = await this.driver.findAll(q.using, q.value).catch(() => [] as ElementRef[]);
      if (els.length) return els;
    }
    return [];
  }

  private async find(locators: Locator[]): Promise<ElementRef | undefined> {
    for (const l of locators)
      for (const q of this.platform.queries(l)) {
        const els = await this.driver.findAll(q.using, q.value).catch(() => []);
        if (els.length) return els[0];
      }
    return undefined;
  }

  private async target(fx: number, fy: number) {
    const hit = await this.at(fx, fy);
    if (!hit) throw new StepError('element_not_found', `Nothing to ${this.verb.toLowerCase()} there`);
    if (!hit.locators.length || !hit.el)
      throw new StepError(
        'element_not_found',
        `${hit.describe || 'This element'} has no id, text or label to find it by again; give it an accessibility id in the app`,
      );
    // The element under the point itself (the one its locators were checked against).
    return { ...hit, el: hit.el };
  }

  /** A tap (a click): done in the app; a text field only gets the focus (typing records the step). */
  tap(fx: number, fy: number) {
    return this.click(fx, fy);
  }

  /** A click on a desktop app (a tap on a phone): left, double or right. */
  click(fx: number, fy: number, opts: { button?: 'left' | 'right'; count?: number } = {}) {
    return this.serial(async () => {
      const t = await this.target(fx, fy);
      if (opts.button === 'right') {
        await this.platform.rightClick(this.driver, t.el);
        this.lastField = undefined;
        this.push({
          type: 'ui.rightclick',
          params: {},
          locators: t.locators,
          describe: `Right-click ${t.describe}`,
        });
        return { describe: t.describe, field: false };
      }
      if ((opts.count ?? 1) >= 2) {
        await this.platform.doubleTap(this.driver, t.el);
        this.lastField = undefined;
        const verb = this.platform.kind === 'desktop' ? 'Double-click' : 'Double-tap';
        this.push({
          type: 'ui.dblclick',
          params: {},
          locators: t.locators,
          describe: `${verb} ${t.describe}`,
        });
        return { describe: t.describe, field: false };
      }
      await this.driver.click(t.el);
      if (isField(t.element)) {
        this.lastField = { locators: t.locators, secret: isSecret(t.element) };
        return { describe: t.describe, field: true };
      }
      this.lastField = undefined;
      this.push({
        type: 'ui.click',
        params: {},
        locators: t.locators,
        describe: `${this.verb} ${t.describe}`,
      });
      return { describe: t.describe, field: false };
    });
  }

  /** A key or a shortcut ("Enter", "Control+S"), pressed where the focus is. */
  key(combo: string) {
    return this.serial(async () => {
      const key = combo.trim();
      if (!key) throw new StepError('invalid_params', 'Name a key, e.g. Enter or Control+S');
      await this.platform.pressKey(this.driver, key);
      this.lastField = undefined;
      this.push({ type: 'ui.press', params: { key }, locators: [], describe: `Press ${key}` });
    });
  }

  /** A menu path of a desktop app ("File > Save"). */
  menu(pathText: string) {
    return this.serial(async () => {
      const path = pathText
        .split('>')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!path.length) throw new StepError('invalid_params', 'Name the menu path, e.g. File > Save');
      await this.platform.menu(this.driver, path);
      this.lastField = undefined;
      this.push({
        type: 'ui.menu',
        params: { path: path.join(' > ') },
        locators: [],
        describe: `Choose ${path.join(' > ')}`,
      });
    });
  }

  /** Scrolls a desktop app's window. */
  scroll(direction: 'up' | 'down') {
    return this.serial(async () => {
      await this.platform.scroll(this.driver, direction);
      this.lastField = undefined;
      this.push({ type: 'ui.scroll', params: { y: direction === 'down' ? 600 : -600 }, locators: [] });
    });
  }

  longPress(fx: number, fy: number) {
    return this.serial(async () => {
      const t = await this.target(fx, fy);
      await this.platform.longPress(this.driver, t.el, 1000);
      this.lastField = undefined;
      this.push({
        type: 'ui.longPress',
        params: {},
        locators: t.locators,
        describe: `Long-press ${t.describe}`,
      });
    });
  }

  /** Types into the field tapped last; typing again into the same field updates its step. Passwords become secrets. */
  type(text: string) {
    return this.serial(async () => {
      const f = this.lastField;
      if (!f) throw new StepError('invalid_params', 'Tap a text field first');
      const el = await this.find(f.locators);
      if (!el) throw new StepError('element_not_found', 'The text field went away');
      await this.driver.clear(el);
      await this.driver.sendKeys(el, text);
      let value = text;
      if (f.secret) {
        const best = f.locators[0]!;
        const key = camel(best.strategy === 'xpath' ? 'password' : best.value);
        this.secrets[key] = text;
        value = `{{secret.${key}}}`;
      }
      if (f.step && this.steps.at(-1) === f.step) {
        f.step.params = { value };
        this.changed();
      } else {
        f.step = this.push({ type: 'ui.fill', params: { value }, locators: f.locators, describe: 'Type' });
      }
    });
  }

  swipe(direction: Direction) {
    return this.serial(async () => {
      await this.platform.swipe(this.driver, direction, 0.75);
      this.lastField = undefined;
      this.push({ type: 'ui.swipe', params: { direction }, locators: [] });
    });
  }

  back() {
    return this.serial(async () => {
      await this.driver.back();
      this.lastField = undefined;
      this.push({ type: 'ui.back', params: {}, locators: [] });
    });
  }

  hideKeyboard() {
    return this.serial(async () => {
      await this.platform.hideKeyboard(this.driver);
      this.push({ type: 'ui.hideKeyboard', params: {}, locators: [] });
    });
  }

  /** A check on the element at a point: that it is visible, or that it shows its current text. */
  check(fx: number, fy: number, check: 'visible' | 'text') {
    return this.serial(async () => {
      const t = await this.target(fx, fy);
      const text = (await this.driver.text(t.el)).trim();
      if (check === 'text' && !text)
        throw new StepError('invalid_params', 'This element shows no text to check');
      this.push({
        type: 'ui.assert',
        params: check === 'text' ? { check: 'text', expected: text } : { check: 'visible' },
        locators: t.locators,
        describe: check === 'text' ? `Check ${t.describe} shows "${text}"` : `Check ${t.describe} is visible`,
      });
    });
  }

  undo(): NativeRecordedStep | undefined {
    const removed = this.steps.pop();
    if (this.lastField?.step === removed) this.lastField = undefined;
    this.changed();
    return removed;
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    await this.busy;
    await this.driver.quit();
    this.changed();
    this.opts.onStop?.(this.snapshot());
  }
}
