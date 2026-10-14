import { StepError, type Locator } from '@stepforge/core';

/** One way to ask Appium for an element: a W3C/Appium strategy and its selector. */
export type Query = { using: string; value: string };

/** An XPath string literal for any text (XPath 1.0 has no escaping). */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s
    .split("'")
    .map((p) => `'${p}'`)
    .join(`, "'", `)})`;
}

const ui = (selector: string): Query => ({
  using: '-android uiautomator',
  value: `new UiSelector()${selector}`,
});
const json = (s: string) => JSON.stringify(s);

/** Android widget classes for the web's ARIA roles, so `role=button "Sign in"` works in an app too. */
const ROLE_CLASSES: Record<string, string[]> = {
  button: ['android.widget.Button', 'android.widget.ImageButton'],
  textbox: ['android.widget.EditText', 'android.widget.AutoCompleteTextView'],
  searchbox: ['android.widget.EditText', 'android.widget.SearchView'],
  checkbox: ['android.widget.CheckBox', 'android.widget.CheckedTextView'],
  switch: ['android.widget.Switch', 'androidx.appcompat.widget.SwitchCompat'],
  radio: ['android.widget.RadioButton'],
  combobox: ['android.widget.Spinner'],
  img: ['android.widget.ImageView'],
  image: ['android.widget.ImageView'],
  link: ['android.widget.TextView'],
  text: ['android.widget.TextView'],
  heading: ['android.widget.TextView'],
  list: [
    'android.widget.ListView',
    'androidx.recyclerview.widget.RecyclerView',
    'android.widget.LinearLayout',
  ],
  progressbar: ['android.widget.ProgressBar'],
  slider: ['android.widget.SeekBar'],
  tab: ['android.widget.TabWidget', 'android.app.ActionBar$Tab'],
};

/**
 * The Appium queries for one StepForge locator on Android, best first:
 * test id → resource id, then accessibility id (content description); label → accessibility id, then hint;
 * placeholder → hint; text → exact, then contained text; role → widget class (+ text or content description);
 * XPath as is. CSS is for web pages only.
 */
export function androidQueries(l: Locator): Query[] {
  const v = l.value;
  switch (l.strategy) {
    case 'testId':
      return [
        { using: 'id', value: v },
        { using: 'accessibility id', value: v },
      ];
    case 'label':
      return [
        { using: 'accessibility id', value: v },
        { using: 'xpath', value: `//*[@hint=${xpathLiteral(v)}]` },
      ];
    case 'placeholder':
      return [{ using: 'xpath', value: `//*[@hint=${xpathLiteral(v)}]` }];
    case 'text':
      return [ui(`.text(${json(v)})`), ui(`.textContains(${json(v)})`), ui(`.description(${json(v)})`)];
    case 'role': {
      const classes = ROLE_CLASSES[v.toLowerCase()];
      if (!classes)
        throw new StepError(
          'invalid_params',
          `The role "${v}" has no Android equivalent; use a test id, text or XPath (roles: ${Object.keys(ROLE_CLASSES).join(', ')})`,
        );
      const cls = classes.map((c) => `@class=${xpathLiteral(c)}`).join(' or ');
      const named = l.name
        ? `[@text=${xpathLiteral(l.name)} or @content-desc=${xpathLiteral(l.name)} or @hint=${xpathLiteral(l.name)}]`
        : '';
      return [{ using: 'xpath', value: `//*[${cls}]${named}` }];
    }
    case 'xpath':
      return [{ using: 'xpath', value: v }];
    case 'css':
      throw new StepError(
        'invalid_params',
        'CSS locators work on web pages; in an Android app use a test id (resource id), text, a role or XPath',
      );
    default:
      throw new StepError('invalid_params', `The locator "${l.strategy}" is not available for Android apps`);
  }
}
