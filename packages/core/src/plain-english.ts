import type { Locator, Step } from './schemas/steps.ts';

type AnyStep = Pick<Step, 'type' | 'params' | 'locators'> & { label?: string; captureAs?: string };

const q = (v: unknown) => `"${String(v)}"`;
const ROLE_NOUN: Record<string, string> = {
  button: 'button',
  link: 'link',
  textbox: 'field',
  searchbox: 'search field',
  checkbox: 'checkbox',
  radio: 'option',
  combobox: 'dropdown',
  listbox: 'list',
  option: 'option',
  tab: 'tab',
  menuitem: 'menu item',
  heading: 'heading',
  row: 'row',
  cell: 'cell',
  img: 'image',
  dialog: 'dialog',
  status: 'status message',
  alert: 'alert',
};

const READABLE: Locator['strategy'][] = ['role', 'label', 'placeholder', 'text'];

/**
 * Describes the element a step targets. Prefers a human-readable locator (role + name, label,
 * placeholder, text) from the ranked list even when a test id or CSS selector is the one used to run.
 */
export function describeTarget(locators: Locator[] = []): string {
  const l =
    locators.find((x) => READABLE.includes(x.strategy) && (x.strategy !== 'role' || x.name)) ?? locators[0];
  if (!l) return 'the page';
  switch (l.strategy) {
    case 'role':
      return l.name
        ? `the ${q(l.name)} ${ROLE_NOUN[l.value] ?? l.value}`
        : `the ${ROLE_NOUN[l.value] ?? l.value}`;
    case 'label':
      return `the ${q(l.value)} field`;
    case 'placeholder':
      return `the field with placeholder ${q(l.value)}`;
    case 'text':
      return q(l.value);
    case 'testId':
      return `the element ${q(l.value)}`;
    case 'css':
    case 'xpath':
      return `the element ${q(l.value)}`;
  }
}

const ASSERT_PHRASE: Record<string, (target: string, expected: unknown) => string> = {
  visible: (t) => `Check that ${t} is visible`,
  hidden: (t) => `Check that ${t} is hidden`,
  text: (t, e) => (t === q(e) ? `Check that ${t} is shown` : `Check that ${t} reads ${q(e)}`),
  textContains: (t, e) => `Check that ${t} contains ${q(e)}`,
  textMatches: (t, e) => `Check that ${t} matches /${String(e)}/`,
  value: (t, e) => `Check that ${t} has the value ${q(e)}`,
  count: (t, e) => `Check that there are ${String(e)} × ${t}`,
  attribute: (t, e) => `Check an attribute of ${t} equals ${q(e)}`,
  enabled: (t) => `Check that ${t} is enabled`,
  disabled: (t) => `Check that ${t} is disabled`,
  checked: (t) => `Check that ${t} is checked`,
  unchecked: (t) => `Check that ${t} is not checked`,
  url: (_t, e) => `Check that the URL is ${q(e)}`,
  urlContains: (_t, e) => `Check that the URL contains ${q(e)}`,
  urlMatches: (_t, e) => `Check that the URL matches /${String(e)}/`,
  title: (_t, e) => `Check that the page title is ${q(e)}`,
  titleContains: (_t, e) => `Check that the page title contains ${q(e)}`,
};

/**
 * Renders one step as a readable sentence, e.g. `Type "{{data.email}}" into the "Email" field`.
 * Used by the plain-English view, bug reports ("Steps to reproduce") and exported test documentation.
 */
export function describeStep(step: AnyStep): string {
  const p = (step.params ?? {}) as Record<string, unknown>;
  const t = describeTarget(step.locators);
  const [group, name] = step.type.split('.') as [string, string];
  let s: string;
  switch (step.type) {
    case 'ui.navigate':
      s = `Open ${String(p.url ?? '/')}`;
      break;
    case 'ui.click':
      s = `Click ${t}`;
      break;
    case 'ui.dblclick':
      s = `Double-click ${t}`;
      break;
    case 'ui.rightclick':
      s = `Right-click ${t}`;
      break;
    case 'ui.hover':
      s = `Hover over ${t}`;
      break;
    case 'ui.fill':
    case 'ui.type':
      s = `Type ${q(p.value ?? '')} into ${t}`;
      break;
    case 'ui.clear':
      s = `Clear ${t}`;
      break;
    case 'ui.press':
      s = step.locators.length
        ? `Press ${String(p.key ?? 'Enter')} in ${t}`
        : `Press ${String(p.key ?? 'Enter')}`;
      break;
    case 'ui.select':
      s = `Select ${q(p.label ?? p.value ?? p.index)} in ${t}`;
      break;
    case 'ui.check':
      s = `Tick ${t}`;
      break;
    case 'ui.uncheck':
      s = `Untick ${t}`;
      break;
    case 'ui.upload':
      s = `Upload ${Array.isArray(p.files) ? p.files.join(', ') : String(p.file ?? 'a file')} to ${t}`;
      break;
    case 'ui.dragDrop':
      s = `Drag ${t} onto ${describeTarget(p.target as Locator[])}`;
      break;
    case 'ui.scroll':
      s = step.locators.length ? `Scroll to ${t}` : 'Scroll down the page';
      break;
    case 'ui.switchTab':
      s = p.urlContains
        ? `Switch to the tab whose URL contains ${q(p.urlContains)}`
        : 'Switch to the new tab';
      break;
    case 'ui.closeTab':
      s = 'Close the current tab';
      break;
    case 'ui.handleDialog':
      s = `${p.action === 'dismiss' ? 'Dismiss' : 'Accept'} the next browser dialog`;
      break;
    case 'ui.switchFrame':
      s = p.main || !p.selector ? 'Return to the main page' : `Switch into the frame ${q(p.selector)}`;
      break;
    case 'ui.waitFor':
      s = step.locators.length
        ? `Wait until ${t} is ${String(p.state ?? 'visible')}`
        : p.url
          ? `Wait for the URL ${String(p.url)}`
          : 'Wait for the page to load';
      break;
    case 'ui.screenshot':
      s = `Take a screenshot of ${t}`;
      break;
    case 'ui.extract':
      s = `Read the ${String(p.from ?? 'text')} of ${t}`;
      break;
    case 'ui.assert': {
      const phrase = ASSERT_PHRASE[String(p.check ?? 'visible')];
      s = phrase ? phrase(t, p.expected) : `Check ${t}`;
      break;
    }
    case 'api.request':
      s = `Send ${String(p.method ?? 'GET')} ${String(p.url ?? '')}`;
      break;
    case 'api.graphql':
      s = `Send a GraphQL query to ${String(p.url ?? '')}`;
      break;
    case 'db.query':
      s = `Run the SQL query ${q(
        String(p.sql ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 80),
      )}${p.connection ? ` on ${String(p.connection)}` : ''}`;
      break;
    case 'db.mongoFind':
      s = `Find documents in ${String(p.collection ?? 'a collection')}${p.connection ? ` on ${String(p.connection)}` : ''}`;
      break;
    case 'db.runScript':
      s = `Run a SQL script${p.connection ? ` on ${String(p.connection)}` : ''}`;
      break;
    case 'db.callProcedure':
      s = `Call the procedure ${String(p.procedure ?? '')}`;
      break;
    case 'db.extract':
      s = `Read ${String(p.path ?? 'value')} from the query result`;
      break;
    case 'db.dataQualityCheck':
      s = `Check data quality${p.tables ? ` of ${Array.isArray(p.tables) ? p.tables.join(', ') : String(p.tables)}` : ''}${p.connection ? ` on ${String(p.connection)}` : ''}`;
      break;
    case 'email.waitForEmail':
      s = `Wait for an email${p.to ? ` to ${String(p.to)}` : ''}${p.subject ? ` with subject ${q(p.subject)}` : ''}`;
      break;
    case 'email.extractFromEmail':
      s = `Read ${p.pattern === 'otp' || p.otp ? 'the one-time code' : 'a value'} from the email`;
      break;
    case 'email.openEmailLink':
      s = 'Open the link in the email';
      break;
    case 'perf.pageMetrics':
      s = 'Measure page performance (LCP, CLS, TTFB)';
      break;
    case 'perf.loadTest':
      s = `Load test ${String(p.url ?? 'the endpoint')}`;
      break;
    case 'util.setVariable':
      s = `Remember ${q(p.value)} as ${String(p.name)}`;
      break;
    case 'util.generateData':
      s = `Generate a random ${String(p.kind ?? 'value')}`;
      break;
    case 'util.wait':
      s = `Wait ${String(p.ms ?? 1000)} ms`;
      break;
    case 'util.log':
      s = `Note: ${String(p.message ?? '')}`;
      break;
    case 'util.runScript':
      s = 'Run a script';
      break;
    case 'util.if': {
      const c = (p.condition ?? {}) as { value?: unknown; operator?: string; expected?: unknown };
      s =
        `If ${String(c.value ?? '')} ${c.operator ?? 'equals'} ${c.expected === undefined ? '' : q(c.expected)}`.trim();
      break;
    }
    case 'util.loop':
      s =
        p.over !== undefined
          ? `Repeat for each ${String(p.as ?? 'item')} in ${String(p.over)}`
          : `Repeat ${String(p.count ?? 1)} times`;
      break;
    case 'util.callScenario':
      s = 'Run another scenario';
      break;
    case 'util.useBlock':
      s = 'Run a reusable block';
      break;
    default:
      s = `${group} ${name}`;
  }
  if (step.captureAs) s += ` (save as ${step.captureAs})`;
  return s;
}

export type PlainLine = { number: string; text: string; depth: number };

/** Numbers steps (with nested control flow) as readable lines: 1, 2, 2.1, 2.2 … */
export function describeSteps(
  steps: (AnyStep & { enabled?: boolean })[],
  prefix = '',
  depth = 0,
): PlainLine[] {
  const out: PlainLine[] = [];
  let n = 0;
  for (const step of steps) {
    if (step.enabled === false) continue;
    n++;
    const number = prefix ? `${prefix}.${n}` : String(n);
    out.push({
      number,
      text: step.label?.trim() ? `${describeStep(step)} — ${step.label}` : describeStep(step),
      depth,
    });
    const p = (step.params ?? {}) as Record<string, unknown>;
    if (Array.isArray(p.steps)) out.push(...describeSteps(p.steps as AnyStep[], number, depth + 1));
    if (Array.isArray(p.else) && p.else.length) {
      out.push({ number: `${number}e`, text: 'Otherwise', depth: depth + 1 });
      out.push(...describeSteps(p.else as AnyStep[], `${number}e`, depth + 2));
    }
  }
  return out;
}
