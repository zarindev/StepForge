import { CREDIT, day, headerLines, readme, testPath } from '../common.ts';
import type { El, Loc, Op, Plan, TestPlan } from '../ir.ts';
import { GITLAB_NATIVE, nativeCi, PLATFORM_NAMES } from '../native.ts';
import type { CodegenOptions, GeneratedProject, Warning } from '../types.ts';
import { envName, kebab, parseString, snake, type Ref, type Val } from '../values.ts';

/**
 * Maestro flows (YAML) for Android and iOS apps. Maestro finds elements by id or text (no XPath, no fallbacks), waits
 * by itself, and runs flows with its own CLI. What it cannot express becomes a `# TODO(StepForge)` comment.
 *
 * Placeholders: {{data.x}} → ${x} (each test case's env), {{env.x}} → ${X} (with the exported default),
 * {{secret.x}} → ${MAESTRO_X} (Maestro reads MAESTRO_* variables from the shell), {{vars.x}} → ${output.x}.
 */
type Ctx = {
  lines: string[];
  warn: (m: string) => void;
  envs: Set<string>;
  secrets: Set<string>;
  platform: 'android' | 'ios';
};

const yq = (s: string) => JSON.stringify(s);
const regexEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dataName = (name: string) => (/^[A-Za-z_]\w*$/.test(name) ? name : snake(name));

function ref(r: Ref, c: Ctx): string | null {
  switch (r.scope) {
    case 'data':
      return `\${${dataName(r.name)}}`;
    case 'vars':
      return /^[A-Za-z_]\w*$/.test(r.name) ? `\${output.${r.name}}` : null;
    case 'env':
      c.envs.add(r.name);
      return `\${${envName(r.name)}}`;
    case 'baseUrl':
      c.envs.add('baseUrl');
      return '${BASE_URL}';
    case 'secret':
      c.secrets.add(r.name);
      return `\${MAESTRO_${envName(r.name)}}`;
    default:
      return null;
  }
}

/** A value as Maestro text (with ${…} placeholders); `regex` escapes the literal parts for text selectors. */
function text(v: Val, c: Ctx, regex = false): string | null {
  if (v.t === 'num' || v.t === 'bool') return String(v.v);
  if (v.t === 'null') return '';
  if (v.t === 'ref') return ref(v.ref, c);
  if (v.t !== 'str') return null;
  let out = '';
  for (const p of v.parts) {
    if (typeof p === 'string') out += regex ? regexEscape(p) : p;
    else {
      const r = ref(p, c);
      if (r === null) return null;
      out += r;
    }
  }
  return out;
}

/** Maestro selector for an element: its first locator Maestro can express (id or text). */
function selector(el: El, c: Ctx): Record<string, string> | null {
  for (const l of [el.loc, ...el.alts]) {
    const s = locSelector(l, c);
    if (s) return s;
  }
  return null;
}

function locSelector(l: Loc, c: Ctx): Record<string, string> | null {
  const v = (s: string) => text(parseString(s), c, true);
  switch (l.strategy) {
    case 'testId': {
      const id = v(l.value);
      return id === null ? null : { id };
    }
    // StepForge matches text exactly, then contained; Maestro's text is a regex for the whole text.
    case 'text': {
      const t = v(l.value);
      return t === null ? null : { text: `.*${t}.*` };
    }
    case 'label':
    case 'placeholder': {
      const t = v(l.value);
      return t === null ? null : { text: t };
    }
    case 'role': {
      if (!l.name) return null;
      const t = v(l.name);
      return t === null ? null : { text: t };
    }
    default:
      return null;
  }
}

const sel = (s: Record<string, string | boolean>) =>
  `{ ${Object.entries(s)
    .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? v : yq(v)}`)
    .join(', ')} }`;

const KEYS: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Home: 'Home',
  Back: 'Back',
  Tab: 'Tab',
  Escape: 'Escape',
  Space: 'Space',
};

/** A JavaScript condition for Maestro's `when: true:` (values as JS, placeholders as variables). */
function jsCond(value: Val, operator: string, expected: Val, c: Ctx): string | null {
  const js = (v: Val): string | null => {
    if (v.t === 'num' || v.t === 'bool') return String(v.v);
    if (v.t === 'null') return 'null';
    const t = text(v, c);
    if (t === null) return null;
    // ${a} inside a JS expression is just the variable a.
    const parts = t.split(/(\$\{[^}]+\})/).filter(Boolean);
    return parts.map((p) => (p.startsWith('${') ? `String(${p.slice(2, -1)})` : yq(p))).join(' + ') || '""';
  };
  const [a, b] = [js(value), js(expected)];
  if (a === null || b === null) return null;
  const op: Record<string, string> = {
    equals: `${a} == ${b}`,
    notEquals: `${a} != ${b}`,
    contains: `String(${a}).includes(${b})`,
    notContains: `!String(${a}).includes(${b})`,
    greaterThan: `Number(${a}) > Number(${b})`,
    lessThan: `Number(${a}) < Number(${b})`,
  };
  return op[operator] ?? null;
}

function printOps(ops: Op[], c: Ctx, ind: string): void {
  const out = (l: string) => c.lines.push(`${ind}${l}`);
  const todo = (m: string) => {
    c.warn(m);
    out(`# TODO(StepForge): ${m}`);
  };
  const need = (el: El): Record<string, string> | null => {
    const s = selector(el, c);
    if (!s)
      todo(
        `no locator Maestro can use (an id, text, label or placeholder) for ${el.loc.strategy}=${el.loc.value}`,
      );
    return s;
  };
  const value = (v: Val | undefined) => {
    const t = v ? text(v, c) : '';
    if (t === null) todo('a value with a placeholder Maestro cannot fill in');
    return t;
  };
  for (const op of ops) {
    switch (op.op) {
      case 'comment':
        out(`# ${op.text}`);
        break;
      case 'todo':
        out(`# TODO(StepForge): ${op.text}`);
        break;
      case 'act': {
        const s = need(op.el);
        if (!s) break;
        if (op.action === 'click') out(`- tapOn: ${sel(s)}`);
        else if (op.action === 'dblclick') out(`- doubleTapOn: ${sel(s)}`);
        else if (op.action === 'fill' || op.action === 'type' || op.action === 'clear') {
          const t = op.action === 'clear' ? '' : value(op.value);
          if (t === null) break;
          out(`- tapOn: ${sel(s)}`);
          if (op.action !== 'type') out('- eraseText');
          if (t) out(`- inputText: ${yq(t)}`);
        } else if (op.action === 'check' || op.action === 'uncheck') {
          out('- runFlow:');
          out('    when:');
          out(`      visible: ${sel({ ...s, checked: op.action === 'uncheck' })}`);
          out('    commands:');
          out(`      - tapOn: ${sel(s)}`);
        } else if (op.action === 'scrollIntoView') {
          out('- scrollUntilVisible:');
          out(`    element: ${sel(s)}`);
        } else todo(`${op.action} is not available in phone apps`);
        break;
      }
      case 'press': {
        const key = KEYS[op.key];
        if (!key) {
          todo(`the key "${op.key}" has no Maestro equivalent`);
          break;
        }
        if (op.el) {
          const s = need(op.el);
          if (!s) break;
          out(`- tapOn: ${sel(s)}`);
        }
        out(`- pressKey: ${key}`);
        break;
      }
      case 'assert': {
        const s = op.el ? need(op.el) : null;
        if (!s) {
          if (!op.el) todo(`the ${op.check} check needs an element`);
          break;
        }
        const exp = op.expected ? text(op.expected, c, true) : '';
        if (exp === null) {
          todo('an expected value with a placeholder Maestro cannot fill in');
          break;
        }
        // Text checks: the element must also show that text (Maestro matches both).
        const withText = (t: string) => ({ ...s, text: t });
        const map: Record<string, () => string | null> = {
          visible: () => `- assertVisible: ${sel(s)}`,
          hidden: () => `- assertNotVisible: ${sel(s)}`,
          text: () => `- assertVisible: ${sel(withText(exp))}`,
          value: () => `- assertVisible: ${sel(withText(exp))}`,
          textContains: () => `- assertVisible: ${sel(withText(`.*${exp}.*`))}`,
          textMatches: () =>
            op.expected && text(op.expected, c) !== null
              ? `- assertVisible: ${sel(withText(text(op.expected, c)!))}`
              : null,
          enabled: () => `- assertVisible: ${sel({ ...s, enabled: true })}`,
          disabled: () => `- assertVisible: ${sel({ ...s, enabled: false })}`,
          checked: () => `- assertVisible: ${sel({ ...s, checked: true })}`,
          unchecked: () => `- assertVisible: ${sel({ ...s, checked: false })}`,
        };
        const line = map[op.check]?.();
        if (line) out(line);
        else todo(`the ${op.check} check has no Maestro equivalent; check it in a script`);
        break;
      }
      case 'read': {
        if (op.source !== 'text' && op.source !== 'value') {
          todo(`reading the ${op.source} has no Maestro equivalent`);
          break;
        }
        const s = op.el ? need(op.el) : null;
        if (!s) break;
        out(`- copyTextFrom: ${sel(s)}`);
        out(
          op.regex
            ? `- evalScript: \${output.${op.into} = (maestro.copiedText.match(new RegExp(${yq(op.regex)})) || [])[1] ?? maestro.copiedText}`
            : `- evalScript: \${output.${op.into} = maestro.copiedText.trim()}`,
        );
        break;
      }
      case 'waitFor': {
        const s = need(op.el);
        if (!s) break;
        out('- extendedWaitUntil:');
        out(`    ${op.state === 'hidden' || op.state === 'detached' ? 'notVisible' : 'visible'}: ${sel(s)}`);
        out('    timeout: 30000');
        break;
      }
      case 'screenshot':
        out(`- takeScreenshot: ${yq(`screenshots/${op.name}`)}`);
        break;
      case 'setVar': {
        const t = text(op.value, c);
        if (t === null || !/^[A-Za-z_]\w*$/.test(op.name)) todo('this variable cannot be set in Maestro');
        else out(`- evalScript: \${output.${op.name} = ${yq(t).replace(/\$\{([^}]+)\}/g, '" + $1 + "')}}`);
        break;
      }
      case 'log': {
        const t = text(op.message, c);
        if (t === null) todo('a log message with a placeholder Maestro cannot fill in');
        else out(`- evalScript: \${console.log(${yq(t).replace(/\$\{([^}]+)\}/g, '" + $1 + "')})}`);
        break;
      }
      case 'if': {
        const cond = jsCond(op.value, op.operator, op.expected, c);
        if (!cond) {
          todo(`the condition (${op.operator}) is not exported to Maestro`);
          break;
        }
        out('- runFlow:');
        out('    when:');
        out(`      true: \${${cond}}`);
        out('    commands:');
        printOps(op.then, c, `${ind}      `);
        if (op.else.length) {
          out('- runFlow:');
          out('    when:');
          out(`      true: \${!(${cond})}`);
          out('    commands:');
          printOps(op.else, c, `${ind}      `);
        }
        break;
      }
      case 'loop':
        if (!op.count || op.count.t !== 'num') {
          todo('only loops with a fixed count are exported to Maestro');
          break;
        }
        out('- repeat:');
        out(`    times: ${op.count.v}`);
        out('    commands:');
        printOps(op.body, c, `${ind}      `);
        break;
      case 'app':
        appOp(op, c, out, todo);
        break;
      case 'wait':
        todo(`Maestro has no fixed wait (${op.ms} ms); wait for an element instead (extendedWaitUntil)`);
        break;
      default:
        todo(
          `${op.op} steps are not part of Maestro flows (they test the app's screens); export them to an Appium or API target`,
        );
    }
  }
}

function appOp(
  op: Extract<Op, { op: 'app' }>,
  c: Ctx,
  out: (l: string) => void,
  todo: (m: string) => void,
): void {
  const arg = (i: number) => op.args[i];
  const str = (i: number) => {
    const v = arg(i);
    return v ? text(v, c) : null;
  };
  const el = (i: number) => {
    const s = op.els[i] ? selector(op.els[i]!, c) : null;
    if (!s) todo('no locator Maestro can use (an id, text, label or placeholder)');
    return s;
  };
  const upper = (d: string | null) => (d ?? 'up').toUpperCase();
  switch (op.method) {
    case 'swipe':
      out(`- swipe:`);
      out(`    direction: ${upper(str(0))}`);
      break;
    case 'swipeOn': {
      const s = el(0);
      if (!s) break;
      out('- swipe:');
      out(`    from: ${sel(s)}`);
      out(`    direction: ${upper(str(0))}`);
      break;
    }
    case 'scroll':
      if (str(0) === 'up') {
        out('- swipe:');
        out('    direction: DOWN');
      } else out('- scroll');
      break;
    case 'scrollTo': {
      const s = el(0);
      if (!s) break;
      out('- scrollUntilVisible:');
      out(`    element: ${sel(s)}`);
      out(`    direction: ${upper(str(0) ?? 'down')}`);
      break;
    }
    case 'longPress': {
      const s = el(0);
      if (s) out(`- longPressOn: ${sel(s)}`);
      break;
    }
    case 'select': {
      const s = el(0);
      const label = str(0);
      if (!s || label === null) break;
      out(`- tapOn: ${sel(s)}`);
      out(`- tapOn: ${yq(regexEscape(label))}`);
      break;
    }
    case 'back':
      // iPhones have no Back key: as XCUITest does, tap the navigation bar's back button (UIKit's BackButton).
      if (c.platform === 'ios') {
        out('- tapOn: { id: "BackButton" }');
        break;
      }
      // Maestro types with the on-screen keyboard, and Android's Back first closes it: close it, then go back.
      out('- hideKeyboard:');
      out('    optional: true');
      out('- back');
      break;
    case 'hideKeyboard':
      // As in StepForge, nothing to do when no keyboard is open.
      out('- hideKeyboard:');
      out('    optional: true');
      break;
    case 'rotate':
      out(`- setOrientation: ${str(0) === 'portrait' ? 'PORTRAIT' : 'LANDSCAPE_LEFT'}`);
      break;
    case 'launchApp':
      out('- launchApp');
      break;
    case 'closeApp':
      out('- stopApp');
      break;
    case 'resetApp':
      out('- clearState');
      break;
    case 'deepLink': {
      const url = str(0);
      if (url === null) break;
      out(`- openLink: ${yq(url)}`);
      // iOS asks before it opens an app's own link ("Open in “CareClinic”?"); Appium's deep link does not.
      if (c.platform === 'ios') {
        out('- tapOn:');
        out('    text: "Open"');
        out('    optional: true');
      }
      break;
    }
    case 'setLocation':
      out('- setLocation:');
      out(`    latitude: ${str(0)}`);
      out(`    longitude: ${str(1)}`);
      break;
    case 'handleDialog': {
      const accept = arg(0)?.t === 'bool' ? (arg(0) as { v: boolean }).v : true;
      const label = arg(1) && arg(1)!.t !== 'null' ? str(1) : null;
      // Without a button name: the usual words for yes / no on Android and iOS dialogs.
      const target = label
        ? regexEscape(label)
        : accept
          ? '(?i)(OK|Allow|Yes|Accept|Continue|Turn on)'
          : '(?i)(Cancel|Don.t Allow|No|Not now|Dismiss)';
      out(`- tapOn: ${yq(target)}`);
      break;
    }
    case 'backgroundApp':
      todo('Maestro cannot put the app in the background for a while; use stopApp and launchApp');
      break;
    case 'permission':
      todo('Maestro sets permissions when it launches the app: add `permissions:` to launchApp');
      break;
    case 'pushNotification':
      todo('Maestro cannot send notifications');
      break;
    case 'menu':
      todo('menu bars are for desktop apps; Maestro tests phone apps');
      break;
    case 'drag':
      todo('drag and drop is not exported to Maestro; use swipe with start and end points');
      break;
  }
}

function flowFile(plan: Plan, t: TestPlan, warnings: Warning[]): { body: string[]; c: Ctx } {
  const c: Ctx = {
    lines: [],
    warn: (message) => warnings.push({ scenario: t.scenario.name, message }),
    envs: new Set(),
    secrets: new Set(),
    platform: plan.native === 'ios' ? 'ios' : 'android',
  };
  printOps(t.ops, c, '');
  return { body: c.lines, c };
}

export function generateMaestro(plan: Plan, o: CodegenOptions): GeneratedProject {
  const files: Record<string, string> = {};
  const warnings: Warning[] = [...plan.warnings];
  const platform = plan.native!;
  const launch = plan.input.environment.launch ?? {};
  const appId = String((platform === 'android' ? launch.appPackage : launch.bundleId) ?? '');
  if (!appId)
    warnings.push({
      message: `Maestro needs the app's ${platform === 'android' ? 'package' : 'bundle id'}: set APP_ID when running the flows (the environment names only the app file)`,
    });
  const reset = launch.resetApp !== false;
  const allSecrets = new Set<string>();
  for (const t of plan.tests) {
    const { body, c } = flowFile(plan, t, warnings);
    for (const s of c.secrets) allSecrets.add(s);
    const tags = [...t.scenario.tags.map((x) => kebab(x)), t.scenario.priority.toLowerCase()];
    const env = [...c.envs].map((n) =>
      n === 'baseUrl'
        ? `  BASE_URL: ${yq(plan.input.environment.baseUrl)}`
        : `  ${envName(n)}: ${yq(plan.input.environment.variables[n] ?? '')}`,
    );
    const header = (name: string, extraEnv: string[]) => [
      ...headerLines(plan.input, t.scenario).map((l) => `# ${l}`),
      `appId: ${appId || '${APP_ID}'}`,
      `name: ${yq(name)}`,
      `tags: [${tags.map(yq).join(', ')}]`,
      ...(env.length || extraEnv.length ? ['env:', ...env, ...extraEnv] : []),
      '---',
    ];
    const start = [`- launchApp:`, `    clearState: ${reset}`];
    const base = testPath(t, (b) => b, 'flows')
      .replace(/^flows\//, '')
      .replace(/\//g, '-');
    if (!t.scenario.testCases.length) {
      files[`flows/${base}.yaml`] = [...header(t.scenario.name, []), ...start, ...body, ''].join('\n');
      continue;
    }
    // Test cases: one flow each, running the scenario's steps (flows/steps/) with that row's data.
    files[`flows/steps/${base}.yaml`] = [
      `# ${CREDIT} · the steps of "${t.scenario.name}", run by each test case's flow`,
      `appId: ${appId || '${APP_ID}'}`,
      '---',
      ...start,
      ...body,
      '',
    ].join('\n');
    for (const tc of t.scenario.testCases) {
      const data = Object.entries(tc.data).map(
        ([k, v]) => `  ${dataName(k)}: ${yq(typeof v === 'string' ? v : JSON.stringify(v))}`,
      );
      files[`flows/${base}-${kebab(tc.code || tc.title)}.yaml`] = [
        ...header(`${t.scenario.name} — ${`${tc.code} ${tc.title}`.trim()}`, data),
        `- runFlow: steps/${base}.yaml`,
        '',
      ].join('\n');
    }
  }
  files['config.yaml'] = [
    `# ${CREDIT}`,
    '# `maestro test flows` runs the flows in flows/ (not the shared steps in flows/steps/).',
    'flows:',
    '  - "*"',
    '',
  ].join('\n');
  const secrets = [...allSecrets].map((s) => `MAESTRO_${envName(s)}`);
  // Maestro takes its settings from the shell, not from APPIUM_URL / APP (Appium's).
  const flat = { ...plan, native: null, secrets: [...allSecrets] };
  files['.env.example'] = [
    `# ${CREDIT}`,
    '# Load into the shell before running Maestro: set -a && . ./.env && set +a',
    ...(appId ? [] : ['# The app under test (its package or bundle id)', 'APP_ID=']),
    ...secrets.map((k) => `# a secret — never commit its value\n${k}=`),
    '',
  ].join('\n');
  const install =
    platform === 'android'
      ? 'adb install -r path/to/app.apk                        # the app under test'
      : 'xcrun simctl install booted path/to/App.app           # the app under test, on a booted simulator';
  files['.gitignore'] = ['screenshots/', 'results/', ''].join('\n');
  Object.assign(
    files,
    nativeCi(
      flat,
      platform,
      {
        setup: [
          '      - uses: actions/setup-java@v4',
          '        with:',
          '          distribution: temurin',
          "          java-version: '17'",
          '      - run: curl -fsSL "https://get.maestro.mobile.dev" | bash && echo "$HOME/.maestro/bin" >> "$GITHUB_PATH"',
        ],
        test: `${secrets.map((k) => `${k}=$${k.slice(8)} `).join('')}MAESTRO_CLI_NO_ANALYTICS=1 maestro test --format junit --output results/junit.xml${appId ? '' : ' -e APP_ID=$APP_ID'} flows`,
      },
      o.ci,
      false,
    ),
  );
  if (o.ci?.includes('gitlab')) warnings.push(GITLAB_NATIVE);
  files['README.md'] = readme(
    { ...flat, warnings },
    {
      title: `Maestro flows — ${PLATFORM_NAMES[platform]}`,
      install: [
        'curl -fsSL "https://get.maestro.mobile.dev" | bash    # Maestro (open source, Apache-2.0; needs Java 17+)',
        'export MAESTRO_CLI_NO_ANALYTICS=1                    # keep Maestro from sending usage data',
        install,
        'set -a && . ./.env && set +a                          # secrets (MAESTRO_*) and APP_ID, from .env',
      ],
      run: [
        `maestro test${appId ? '' : ' -e APP_ID=$APP_ID'} flows                     # all flows`,
        'maestro test --include-tags smoke flows            # one tag',
        'maestro test --format junit --output results/junit.xml flows',
      ],
      layout: [
        '`flows/` — one flow per scenario (one per test case, each with its data as env)',
        '`flows/steps/` — the steps shared by the test cases of a scenario',
      ],
      notes: [
        'Maestro finds an element by its id or its text (label, placeholder); StepForge exports the first locator it can express. XPath and fallback locators are not exported.',
        'Values: test data, {{env.x}} and {{vars.x}} become Maestro variables; secrets are read from MAESTRO_* environment variables.',
        `Exported on ${day(plan.input)}; re-export from StepForge after changing the scenarios.`,
      ],
    },
  );
  return { target: 'maestro', files, warnings, run: 'maestro test flows' };
}
