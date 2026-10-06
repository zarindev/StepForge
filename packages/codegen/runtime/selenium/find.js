// Finds elements the way StepForge's locators do (by Md Zarin Tasnim). Runs in the page through Selenium:
/* global arguments, document */
// arguments[0] = strategy (testId | role | label | placeholder | text), arguments[1] = value, arguments[2] = name.
var strategy = arguments[0],
  value = arguments[1],
  name = arguments[2];
var root = arguments[3] || document;
var norm = function (s) {
  return (s || '').replace(/\s+/g, ' ').trim();
};
var visible = function (el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
};
var all = function (sel) {
  return Array.prototype.slice.call(root.querySelectorAll(sel));
};

var IMPLICIT = {
  button: 'button, input[type=button], input[type=submit], input[type=reset], input[type=image], summary',
  link: 'a[href], area[href]',
  textbox:
    'input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=url], input[type=password], textarea',
  searchbox: 'input[type=search]',
  checkbox: 'input[type=checkbox]',
  radio: 'input[type=radio]',
  combobox: 'select:not([multiple]), input[list]',
  listbox: 'select[multiple]',
  option: 'option',
  heading: 'h1, h2, h3, h4, h5, h6',
  img: 'img[alt]',
  list: 'ul, ol',
  listitem: 'li',
  table: 'table',
  row: 'tr',
  cell: 'td',
  columnheader: 'th',
  navigation: 'nav',
  main: 'main',
  form: 'form',
  dialog: 'dialog',
  status: 'output',
  spinbutton: 'input[type=number]',
  slider: 'input[type=range]',
};

function labelText(el) {
  var parts = [];
  if (el.id)
    all('label[for="' + el.id.replace(/"/g, '\\"') + '"]').forEach(function (l) {
      parts.push(l.textContent);
    });
  var wrap = el.closest && el.closest('label');
  if (wrap) parts.push(wrap.textContent);
  return parts.map(norm);
}

function accessibleName(el) {
  var by = el.getAttribute('aria-labelledby');
  if (by)
    return norm(
      by
        .split(/\s+/)
        .map(function (id) {
          var x = document.getElementById(id);
          return x ? x.textContent : '';
        })
        .join(' '),
    );
  if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
  var tag = el.tagName.toLowerCase();
  if (/^(input|select|textarea)$/.test(tag)) {
    if (/^(button|submit|reset)$/.test(el.type))
      return norm(el.value || (el.type === 'submit' ? 'Submit' : ''));
    var labels = labelText(el);
    if (labels.length) return labels[0];
    return norm(el.getAttribute('title') || el.getAttribute('placeholder'));
  }
  if (tag === 'img') return norm(el.getAttribute('alt'));
  return norm(el.textContent || el.getAttribute('title'));
}

var found = [];
if (strategy === 'testId') {
  found = all(
    '[data-testid="' +
      value +
      '"], [data-test="' +
      value +
      '"], [data-cy="' +
      value +
      '"], [data-qa="' +
      value +
      '"]',
  );
} else if (strategy === 'role') {
  var sel = '[role="' + value + '"]' + (IMPLICIT[value] ? ', ' + IMPLICIT[value] : '');
  found = all(sel).filter(function (el) {
    var explicit = el.getAttribute('role');
    if (explicit && explicit !== value) return false;
    return name == null || accessibleName(el) === norm(name);
  });
} else if (strategy === 'label') {
  found = all('input, select, textarea, [aria-label], [aria-labelledby]').filter(function (el) {
    return (
      labelText(el).indexOf(norm(value)) >= 0 ||
      norm(el.getAttribute('aria-label')) === norm(value) ||
      (el.getAttribute('aria-labelledby') && accessibleName(el) === norm(value))
    );
  });
} else if (strategy === 'placeholder') {
  found = all('[placeholder]').filter(function (el) {
    return norm(el.getAttribute('placeholder')) === norm(value);
  });
} else if (strategy === 'text') {
  found = all('body *').filter(function (el) {
    if (/^(script|style|head|title)$/i.test(el.tagName) || norm(el.textContent) !== norm(value)) return false;
    // The innermost element with that text.
    return !Array.prototype.some.call(el.children, function (c) {
      return norm(c.textContent) === norm(value);
    });
  });
}
// Visible matches first, like a user would see them.
return found.filter(visible).concat(
  found.filter(function (el) {
    return !visible(el);
  }),
);
