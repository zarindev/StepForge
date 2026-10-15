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
    case 'element':
      return 'a saved element';
    case 'image':
      return 'the picture';
    case 'testId':
      return `the element ${q(l.value)}`;
    case 'css':
    case 'xpath':
      return `the element ${q(l.value)}`;
  }
}

const PAGE_PHRASE: Record<string, (target: string, expected: unknown) => string> = {
  visible: (t) => `${t} is visible`,
  hidden: (t) => `${t} is hidden`,
  present: (t) => `${t} is on the page`,
  absent: (t) => `${t} is not on the page`,
  enabled: (t) => `${t} is enabled`,
  textContains: (t, e) => `${t} contains ${q(e ?? '')}`,
  count: (t, e) => `there are ${String(e ?? '?')} × ${t}`,
};

/** A `util.if` / `util.loop` condition: a value comparison, or a check on the step's element. */
function condition(raw: unknown, target: string): string {
  const c = (raw ?? {}) as {
    type?: string;
    value?: unknown;
    operator?: string;
    expected?: unknown;
    check?: string;
  };
  if (c.type === 'element')
    return (PAGE_PHRASE[c.check ?? 'visible'] ?? PAGE_PHRASE.visible!)(target, c.expected);
  return `${String(c.value ?? '')} ${c.operator ?? 'equals'} ${c.expected === undefined ? '' : q(c.expected)}`.trim();
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
      s = `Click ${t}${p.x !== undefined && p.y !== undefined ? ` at ${String(p.x)},${String(p.y)}` : ''}`;
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
      // Browser dialogs, and the alerts and sheets of phone and desktop apps.
      s = p.buttonLabel
        ? `Press ${q(p.buttonLabel)} in the dialog`
        : `${p.action === 'dismiss' ? 'Dismiss' : 'Accept'} the next dialog`;
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
    case 'ui.networkSummary':
      s = `Check the network traffic${p.since === 'lastNavigation' ? ' of this page' : ' so far'}`;
      break;
    case 'ui.tap':
      s = `Tap ${t}`;
      break;
    case 'ui.swipe':
      s = Array.isArray(p.target)
        ? `Drag ${t} onto another element`
        : `Swipe ${String(p.direction ?? 'up')}${step.locators.length ? ` on ${t}` : ''}`;
      break;
    case 'ui.longPress':
      s = `Long-press ${t}`;
      break;
    case 'ui.scrollTo':
      s = `Scroll ${String(p.direction ?? 'down')} until ${t} shows`;
      break;
    case 'ui.back':
      s = 'Go back';
      break;
    case 'ui.hideKeyboard':
      s = 'Hide the keyboard';
      break;
    case 'ui.menu':
      s = `Choose ${String(p.path ?? '')} from the menu`;
      break;
    case 'ui.rotate':
      s = `Turn the device to ${String(p.orientation ?? 'landscape')}`;
      break;
    case 'ui.appState': {
      const a = String(p.action ?? 'launch');
      s =
        a === 'close'
          ? 'Close the app'
          : a === 'background'
            ? `Put the app in the background${p.seconds ? ` for ${String(p.seconds)} s` : ''}`
            : a === 'reset'
              ? 'Reset the app’s data'
              : 'Open the app';
      break;
    }
    case 'ui.deepLink':
      s = `Open the link ${String(p.url ?? '')}`;
      break;
    case 'ui.setLocation':
      s = `Set the device location to ${String(p.latitude ?? '')}, ${String(p.longitude ?? '')}`;
      break;
    case 'ui.permission':
      s = `${p.action === 'revoke' ? 'Revoke' : 'Grant'} the ${String(p.permission ?? '')} permission`;
      break;
    case 'ui.pushNotification':
      s = `Send a notification "${String(p.title ?? '')}"`;
      break;
    case 'ui.download':
      s = `Download the file from ${t}`;
      break;
    case 'ui.visualCheckpoint':
      s = `Check that ${t} looks like the approved screenshot`;
      break;
    case 'ui.waitForResponse':
      s = `Wait for the ${p.method ? `${String(p.method)} ` : ''}response from ${String(p.url ?? '')}`;
      break;
    case 'ui.mockRoute': {
      const u = String(p.url ?? '');
      const action = String(p.action ?? 'fulfill');
      s =
        action === 'remove'
          ? `Stop faking ${u}`
          : action === 'abort'
            ? `Make requests to ${u} fail`
            : action === 'delay'
              ? `Slow down requests to ${u} by ${String(p.delayMs ?? 0)} ms`
              : `Answer requests to ${u} with ${String(p.status ?? 200)}`;
      break;
    }
    case 'ui.setOffline':
      s = (p.state ? p.state === 'online' : p.offline === false || p.offline === 'false')
        ? 'Go back online'
        : 'Go offline';
      break;
    case 'ui.storage': {
      const where =
        { cookie: 'cookie', local: 'local storage', session: 'session storage' }[
          String(p.kind ?? 'cookie')
        ] ?? String(p.kind);
      const action = String(p.action ?? 'get');
      s =
        action === 'set'
          ? `Set the ${where} ${q(p.name ?? '')} to ${q(p.value ?? '')}`
          : action === 'clear'
            ? `Clear ${where === 'cookie' ? 'all cookies' : where}`
            : action === 'remove'
              ? `Remove the ${where} ${q(p.name ?? '')}`
              : `Read the ${where} ${q(p.name ?? '')}`;
      break;
    }
    case 'ui.setClock':
      s =
        p.action === 'fastForward'
          ? `Move the clock forward ${String(p.ms ?? 60000)} ms`
          : `Set the page clock to ${String(p.time ?? '')}${p.action === 'install' ? ' (running)' : ''}`;
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
    case 'api.extract':
      s =
        p.from === 'status'
          ? 'Read the response status'
          : p.from === 'header'
            ? `Read the ${String(p.name ?? '')} header of the response`
            : `Read ${String(p.path ?? '$')} from the response`;
      break;
    case 'api.graphql':
      s = `Send a GraphQL query to ${String(p.url ?? '')}`;
      break;
    case 'api.soap':
      s = `Call the SOAP service ${String(p.url ?? '')}${p.action ? ` (${String(p.action).split(/[/#]/).pop()})` : ''}`;
      break;
    case 'api.kafkaProduce':
      s = `Send a Kafka message to ${String(p.topic ?? '')}${p.key ? ` with key ${q(p.key)}` : ''}`;
      break;
    case 'api.kafkaConsume':
      s = `Wait for a Kafka message on ${String(p.topic ?? '')}${
        p.key
          ? ` with key ${q(p.key)}`
          : p.contains
            ? ` containing ${q(p.contains)}`
            : p.path
              ? ` where ${String(p.path)}${p.equals !== undefined ? ` is ${q(p.equals)}` : ''}`
              : ''
      }`;
      break;
    case 'api.ftp': {
      const verb = {
        upload: 'Upload',
        download: 'Download',
        list: 'List',
        delete: 'Delete',
        exists: 'Check that there is',
      }[String(p.action ?? 'list')];
      s = `${verb ?? 'Use'} ${String(p.remotePath ?? '/')} on ${String(p.protocol ?? 'ftp').toUpperCase()} ${String(p.host ?? '')}`;
      break;
    }
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
    case 'email.assertEmail': {
      const checks = [
        p.subjectContains && `the subject contains ${q(p.subjectContains)}`,
        p.bodyContains && `the body contains ${q(p.bodyContains)}`,
        p.from && `it comes from ${String(p.from)}`,
        p.hasLink && (p.hasLink === true ? 'it has a link' : `it has a link containing ${q(p.hasLink)}`),
        p.hasAttachment &&
          (p.hasAttachment === true ? 'it has an attachment' : `it has the attachment ${q(p.hasAttachment)}`),
      ].filter(Boolean);
      s = checks.length ? `Check that ${checks.join(' and ')}` : 'Check the email';
      break;
    }
    case 'email.extractFromEmail':
      s =
        (p.kind ?? 'otp') === 'otp'
          ? 'Read the one-time code from the email'
          : p.kind === 'link'
            ? `Read the ${p.contains ? `${q(p.contains)} ` : ''}link from the email`
            : `Read ${q(p.pattern)} from the email`;
      break;
    case 'email.openEmailLink':
      s = `Open the ${p.contains ? `${q(p.contains)} ` : ''}link in the email`;
      break;
    case 'perf.pageMetrics':
      s = 'Measure page performance (LCP, CLS, TTFB)';
      break;
    case 'perf.loadTest': {
      const n = Array.isArray(p.requests) ? p.requests.length : 0;
      s = `Load test ${n > 1 ? `${n} requests` : String(p.url ?? (p.requests as { url?: string }[] | undefined)?.[0]?.url ?? 'the endpoint')} with ${String(p.vus ?? 10)} users (${String(p.profile ?? 'load')})`;
      break;
    }
    case 'perf.lighthouse':
      s = `Run Lighthouse on ${String(p.url ?? '/')}`;
      break;
    case 'perf.queryPlan':
      s = `Check the query plan of ${q(
        String(p.sql ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 60),
      )}`;
      break;
    case 'util.setVariable':
      s = `Remember ${q(p.value)} as ${String(p.name)}`;
      break;
    case 'util.useData': {
      const pick =
        p.pick === 'random'
          ? 'a random row'
          : p.pick === 'unused'
            ? 'a row not used yet in this run'
            : p.pick === 'row'
              ? `row ${String(p.row ?? 1)}`
              : p.pick === 'match'
                ? `the row whose ${q(p.column)} is ${q(p.equals)}`
                : 'the first row';
      s = `Take ${pick} of the test data ${q(p.source)} as ${String(p.as || dataVarName(String(p.source ?? 'data')))}`;
      break;
    }
    case 'util.generateData':
      s = `Generate a random ${String(p.kind ?? 'value')}`;
      break;
    case 'util.wait':
      s = `Wait ${String(p.ms ?? 1000)} ms`;
      break;
    case 'util.log':
      s = `Note: ${String(p.message ?? '')}`;
      break;
    case 'util.manual':
      s = `${String(p.instruction ?? 'Do this by hand')}${p.expected ? ` — expect: ${String(p.expected)}` : ''}`;
      break;
    case 'util.runScript':
      s = 'Run a script';
      break;
    case 'util.if':
      s = `If ${condition(p.condition, t)}`;
      break;
    case 'util.loop':
      s =
        p.while !== undefined
          ? `Repeat while ${condition(p.while, t)}`
          : p.over !== undefined
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

/** The variable a `util.useData` step stores its row in when it has no "as": the source name in camelCase. */
export function dataVarName(source: string): string {
  const words = source
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words
    .map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w[0]!.toLowerCase() + w.slice(1)))
    .join('');
  return /^[A-Za-z_]/.test(name) ? name : `data${name}`;
}
