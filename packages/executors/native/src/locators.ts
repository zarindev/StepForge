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

/** A string literal for an iOS predicate (NSPredicate): double quotes, with \ and " escaped. */
export function predicateLiteral(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const pred = (value: string): Query => ({ using: '-ios predicate string', value });

/** A predicate literal inside a class chain's `…` brackets: a backtick there is written twice. */
export function classChainLiteral(s: string): string {
  return predicateLiteral(s).replace(/`/g, '``');
}

/** XCUITest element types for the web's ARIA roles, so `role=button "Sign in"` works on an iPhone too. */
const IOS_ROLE_TYPES: Record<string, string[]> = {
  button: ['XCUIElementTypeButton'],
  textbox: ['XCUIElementTypeTextField', 'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextView'],
  searchbox: ['XCUIElementTypeSearchField'],
  checkbox: ['XCUIElementTypeSwitch', 'XCUIElementTypeToggle'],
  switch: ['XCUIElementTypeSwitch', 'XCUIElementTypeToggle'],
  radio: ['XCUIElementTypeButton'],
  combobox: ['XCUIElementTypePickerWheel', 'XCUIElementTypePopUpButton'],
  img: ['XCUIElementTypeImage'],
  image: ['XCUIElementTypeImage'],
  link: ['XCUIElementTypeLink'],
  text: ['XCUIElementTypeStaticText'],
  heading: ['XCUIElementTypeStaticText', 'XCUIElementTypeNavigationBar'],
  list: ['XCUIElementTypeTable', 'XCUIElementTypeCollectionView'],
  progressbar: ['XCUIElementTypeProgressIndicator', 'XCUIElementTypeActivityIndicator'],
  slider: ['XCUIElementTypeSlider'],
  tab: ['XCUIElementTypeTab', 'XCUIElementTypeTabBar'],
};

/**
 * The Appium queries for one StepForge locator on iOS, best first:
 * test id → accessibility identifier; label → accessibility identifier, then label; placeholder → placeholder
 * value; text → label or value, exact then contained; role → element type (+ label, name or placeholder);
 * XPath as is. CSS is for web pages only.
 */
export function iosQueries(l: Locator): Query[] {
  const v = predicateLiteral(l.value);
  switch (l.strategy) {
    case 'testId':
      return [{ using: 'accessibility id', value: l.value }];
    case 'label':
      return [{ using: 'accessibility id', value: l.value }, pred(`label == ${v}`)];
    case 'placeholder':
      return [pred(`placeholderValue == ${v}`)];
    case 'text':
      return [pred(`label == ${v} OR value == ${v}`), pred(`label CONTAINS ${v} OR value CONTAINS ${v}`)];
    case 'role': {
      const types = IOS_ROLE_TYPES[l.value.toLowerCase()];
      if (!types)
        throw new StepError(
          'invalid_params',
          `The role "${l.value}" has no iOS equivalent; use a test id, text or XPath (roles: ${Object.keys(IOS_ROLE_TYPES).join(', ')})`,
        );
      const typeIn = `type IN {${types.map(predicateLiteral).join(', ')}}`;
      if (!l.name) return [pred(typeIn)];
      const n = predicateLiteral(l.name);
      return [pred(`${typeIn} AND (label == ${n} OR name == ${n} OR placeholderValue == ${n})`)];
    }
    case 'xpath':
      return [{ using: 'xpath', value: l.value }];
    case 'css':
      throw new StepError(
        'invalid_params',
        'CSS locators work on web pages; in an iOS app use a test id (accessibility identifier), text, a role or XPath',
      );
    default:
      throw new StepError('invalid_params', `The locator "${l.strategy}" is not available for iOS apps`);
  }
}

/** Mac element types for the web's ARIA roles (each becomes one class-chain query). */
const MAC_ROLE_TYPES: Record<string, string[]> = {
  button: ['XCUIElementTypeButton'],
  textbox: ['XCUIElementTypeTextField', 'XCUIElementTypeSecureTextField', 'XCUIElementTypeTextView'],
  searchbox: ['XCUIElementTypeSearchField'],
  checkbox: ['XCUIElementTypeCheckBox'],
  switch: ['XCUIElementTypeSwitch', 'XCUIElementTypeCheckBox'],
  radio: ['XCUIElementTypeRadioButton'],
  combobox: ['XCUIElementTypePopUpButton', 'XCUIElementTypeComboBox'],
  menuitem: ['XCUIElementTypeMenuItem', 'XCUIElementTypeMenuBarItem'],
  img: ['XCUIElementTypeImage'],
  image: ['XCUIElementTypeImage'],
  link: ['XCUIElementTypeLink'],
  text: ['XCUIElementTypeStaticText'],
  heading: ['XCUIElementTypeStaticText'],
  list: ['XCUIElementTypeTable', 'XCUIElementTypeOutline', 'XCUIElementTypeList'],
  slider: ['XCUIElementTypeSlider'],
  tab: ['XCUIElementTypeTab', 'XCUIElementTypeRadioButton'],
};

/**
 * The Appium (Mac2) queries for one StepForge locator in a macOS app, best first: test id → accessibility
 * identifier; label → identifier, then label or title; placeholder → placeholder value; text → title, label or value
 * (exact, then contained); role → element type with that title or label; XPath as is.
 */
export function macQueries(l: Locator): Query[] {
  const v = predicateLiteral(l.value);
  switch (l.strategy) {
    case 'testId':
      return [{ using: 'accessibility id', value: l.value }];
    case 'label':
      return [{ using: 'accessibility id', value: l.value }, pred(`label == ${v} OR title == ${v}`)];
    case 'placeholder':
      return [pred(`placeholderValue == ${v}`)];
    case 'text':
      return [
        pred(`title == ${v} OR label == ${v} OR value == ${v}`),
        pred(`title CONTAINS ${v} OR label CONTAINS ${v} OR value CONTAINS ${v}`),
      ];
    case 'role': {
      const types = MAC_ROLE_TYPES[l.value.toLowerCase()];
      if (!types)
        throw new StepError(
          'invalid_params',
          `The role "${l.value}" has no macOS equivalent; use a test id, text or XPath (roles: ${Object.keys(MAC_ROLE_TYPES).join(', ')})`,
        );
      const n = l.name ? classChainLiteral(l.name) : undefined;
      return types.map((t) => ({
        using: '-ios class chain',
        value: n ? `**/${t}[\`title == ${n} OR label == ${n} OR placeholderValue == ${n}\`]` : `**/${t}`,
      }));
    }
    case 'xpath':
      return [{ using: 'xpath', value: l.value }];
    case 'css':
      throw new StepError(
        'invalid_params',
        'CSS locators work on web pages; in a macOS app use a test id (accessibility identifier), text, a role or XPath',
      );
    default:
      throw new StepError('invalid_params', `The locator "${l.strategy}" is not available for macOS apps`);
  }
}

/** Windows UI Automation control types for the web's ARIA roles. */
const WINDOWS_ROLE_TYPES: Record<string, string[]> = {
  button: ['Button', 'SplitButton'],
  textbox: ['Edit', 'Document'],
  searchbox: ['Edit'],
  checkbox: ['CheckBox'],
  switch: ['CheckBox', 'Button'],
  radio: ['RadioButton'],
  combobox: ['ComboBox'],
  menuitem: ['MenuItem'],
  img: ['Image'],
  image: ['Image'],
  link: ['Hyperlink'],
  text: ['Text'],
  heading: ['Text', 'Header'],
  list: ['List', 'DataGrid', 'Tree'],
  listitem: ['ListItem', 'DataItem', 'TreeItem'],
  slider: ['Slider'],
  progressbar: ['ProgressBar'],
  tab: ['TabItem'],
};

/**
 * The Appium (NovaWindows) queries for one StepForge locator in a Windows app, best first: test id → AutomationId;
 * label and text → Name (exact, then contained); placeholder → the field's Name or HelpText; role → control type with
 * that Name; XPath as is (control types as tags: //Button[@Name='Save']).
 */
export function windowsQueries(l: Locator): Query[] {
  const v = xpathLiteral(l.value);
  switch (l.strategy) {
    case 'testId':
      return [{ using: 'accessibility id', value: l.value }];
    case 'label':
      return [
        { using: 'name', value: l.value },
        { using: 'accessibility id', value: l.value },
      ];
    case 'placeholder':
      return [{ using: 'xpath', value: `//Edit[@Name=${v} or @HelpText=${v}]` }];
    case 'text':
      return [
        { using: 'name', value: l.value },
        { using: 'xpath', value: `//*[contains(@Name, ${v})]` },
      ];
    case 'role': {
      const types = WINDOWS_ROLE_TYPES[l.value.toLowerCase()];
      if (!types)
        throw new StepError(
          'invalid_params',
          `The role "${l.value}" has no Windows equivalent; use a test id, text or XPath (roles: ${Object.keys(WINDOWS_ROLE_TYPES).join(', ')})`,
        );
      const named = l.name ? `[@Name=${xpathLiteral(l.name)}]` : '';
      return [{ using: 'xpath', value: types.map((t) => `//${t}${named}`).join(' | ') }];
    }
    case 'xpath':
      return [{ using: 'xpath', value: l.value }];
    case 'css':
      throw new StepError(
        'invalid_params',
        'CSS locators work on web pages; in a Windows app use a test id (AutomationId), text, a role or XPath',
      );
    default:
      throw new StepError('invalid_params', `The locator "${l.strategy}" is not available for Windows apps`);
  }
}

/** AT-SPI roles (as the Linux helper's tags) for the web's ARIA roles. */
const LINUX_ROLES: Record<string, string[]> = {
  button: ['push_button', 'toggle_button'],
  textbox: ['text', 'entry', 'password_text', 'editbar'],
  searchbox: ['text', 'entry'],
  checkbox: ['check_box'],
  switch: ['toggle_button', 'check_box'],
  radio: ['radio_button'],
  combobox: ['combo_box'],
  menuitem: ['menu_item', 'menu'],
  img: ['image', 'icon'],
  image: ['image', 'icon'],
  link: ['link'],
  text: ['label', 'static'],
  heading: ['heading', 'label'],
  list: ['list', 'list_box', 'table', 'tree_table'],
  slider: ['slider'],
  progressbar: ['progress_bar'],
  tab: ['page_tab'],
};

/**
 * An element with this role tag and accessible name, for the Linux helper. Its XPath (ElementTree's subset) has no
 * concat(), so a name with both kinds of quotes is looked up by its exact name instead (any role).
 */
export function linuxNamed(tag: string, name: string): Query {
  if (name.includes("'") && name.includes('"')) return { using: 'name', value: name };
  return { using: 'xpath', value: `//${tag}[@name=${xpathLiteral(name)}]` };
}

/**
 * The Linux helper's queries for one StepForge locator, best first: test id → accessible id (GTK:
 * atk_object_set_accessible_id; Qt: objectName); label and text → accessible name (exact, then contained);
 * placeholder → accessible name; role → AT-SPI role with that name; XPath (ElementTree's subset) over role tags.
 */
export function linuxQueries(l: Locator): Query[] {
  switch (l.strategy) {
    case 'testId':
      return [{ using: 'accessibility id', value: l.value }];
    case 'label':
    case 'placeholder':
      return [
        { using: 'name', value: l.value },
        { using: 'accessibility id', value: l.value },
      ];
    case 'text':
      return [
        { using: 'name', value: l.value },
        { using: 'partial name', value: l.value },
      ];
    case 'role': {
      const roles = LINUX_ROLES[l.value.toLowerCase()];
      if (!roles)
        throw new StepError(
          'invalid_params',
          `The role "${l.value}" has no Linux equivalent; use a test id, text or XPath (roles: ${Object.keys(LINUX_ROLES).join(', ')})`,
        );
      if (!l.name) return roles.map((r) => ({ using: 'xpath', value: `//${r}` }));
      const queries = roles.map((r) => linuxNamed(r, l.name!));
      // The name-only fallback is the same for every role: ask once.
      return queries[0]!.using === 'name' ? [queries[0]!] : queries;
    }
    case 'xpath':
      return [{ using: 'xpath', value: l.value }];
    case 'css':
      throw new StepError(
        'invalid_params',
        'CSS locators work on web pages; in a Linux app use a test id, text, a role or XPath',
      );
    default:
      throw new StepError('invalid_params', `The locator "${l.strategy}" is not available for Linux apps`);
  }
}
