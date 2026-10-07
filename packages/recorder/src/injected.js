// StepForge recorder: injected into every page and frame of the recording browser.
// Plain browser JavaScript (no build step). Talks to Node through the exposed binding __stepforgeEmit.
(() => {
  if (window.__sfRecorderInstalled) return;
  window.__sfRecorderInstalled = true;
  const isTop = window === window.top;
  const emit = (payload) =>
    window.__stepforgeEmit ? window.__stepforgeEmit(payload) : Promise.resolve(null);

  // ─── Locator generation ────────────────────────────────────────────────
  const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
  const HASHED =
    /(^|[-_])([a-z]{1,4}[-_])?[a-z0-9]*\d[a-z0-9]{4,}$|^css-|^sc-|^jss\d|^Mui[A-Za-z]+-\w+-\d+|^_[a-zA-Z0-9]{5,}$|^ng-|^ember\d|^react-|:r\d/;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function interactiveAncestor(el) {
    let cur = el;
    for (let i = 0; cur && i < 6; i++, cur = cur.parentElement) {
      if (
        cur.matches?.(
          'button, a[href], input, select, textarea, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [onclick], [data-testid], [data-test], [data-cy]',
        )
      )
        return cur;
    }
    return el;
  }

  function implicitRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(type)))
      return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'input' && type === 'search') return 'searchbox';
    if (tag === 'input' && ['', 'text', 'email', 'tel', 'url', 'password', 'number'].includes(type))
      return type === 'number' ? 'spinbutton' : 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img' && el.getAttribute('alt')) return 'img';
    if (tag === 'option') return 'option';
    return null;
  }

  function labelText(el) {
    if (el.labels && el.labels.length) {
      const l = el.labels[0].cloneNode(true);
      l.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
      return norm(l.textContent);
    }
    return '';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by)
      return norm(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' '),
      );
    const tag = el.tagName.toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag)) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type)) return norm(el.value);
      return labelText(el) || norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
    }
    const text = norm(el.innerText || el.textContent);
    if (text) return text;
    const img = el.querySelector('img[alt]');
    return norm(img?.getAttribute('alt')) || norm(el.getAttribute('title'));
  }

  function countRoleName(role, name) {
    let n = 0;
    for (const e of document.querySelectorAll(
      'a, button, input, select, textarea, h1, h2, h3, h4, h5, h6, img, option, summary, [role]',
    )) {
      if (implicitRole(e) === role && accessibleName(e) === name) n++;
      if (n > 1) break;
    }
    return n;
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      if (cur.id && !HASHED.test(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const name = cur.getAttribute('name');
      const classes = [...cur.classList].filter((c) => !HASHED.test(c)).slice(0, 2);
      if (name && ['input', 'select', 'textarea', 'button'].includes(part))
        part += `[name="${CSS.escape(name)}"]`;
      else if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1 && !name) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
      cur = parent;
    }
    return parts.join(' > ');
  }

  function xpath(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const same = cur.parentElement
        ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName)
        : [cur];
      parts.unshift(`${cur.tagName.toLowerCase()}${same.length > 1 ? `[${same.indexOf(cur) + 1}]` : ''}`);
    }
    return `/${parts.join('/')}`;
  }

  /** Ranked locator candidates (Section 7.2): test id → role+name → label → placeholder → text → css → xpath. */
  function locatorsFor(el) {
    const out = [];
    const add = (strategy, value, score, name) => {
      if (!value || out.some((o) => o.strategy === strategy && o.value === value && o.name === name)) return;
      out.push(name ? { strategy, value, name, score } : { strategy, value, score });
    };
    for (const attr of TEST_ID_ATTRS) {
      const v = el.getAttribute(attr);
      if (v)
        add('testId', v, document.querySelectorAll(`[${attr}="${CSS.escape(v)}"]`).length === 1 ? 100 : 70);
    }
    const role = implicitRole(el);
    const name = role ? accessibleName(el) : '';
    if (role && name && name.length <= 80) add('role', role, countRoleName(role, name) === 1 ? 90 : 55, name);
    const lbl = ['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) ? labelText(el) : '';
    if (lbl) add('label', lbl, 85);
    const ph = el.getAttribute('placeholder');
    if (ph) add('placeholder', ph, 75);
    if (!['input', 'select', 'textarea'].includes(el.tagName.toLowerCase())) {
      const text = norm(el.innerText);
      if (text && text.length <= 60 && !/\d{3,}/.test(text)) add('text', text, 60);
    }
    if (el.id && !HASHED.test(el.id)) add('css', `#${CSS.escape(el.id)}`, 62);
    const path = cssPath(el);
    if (path) add('css', path, document.querySelectorAll(path).length === 1 ? 40 : 10);
    add('xpath', xpath(el), 5);
    out.sort((a, b) => b.score - a.score);
    // Weak structural fallbacks (CSS paths, XPath) cause false "healing" onto the wrong element; keep them
    // only when the element has fewer than two strong, meaningful locators.
    const strong = out.filter((o) => o.score >= 55).length;
    return (strong >= 2 ? out.filter((o) => o.score >= 55) : out).slice(0, 5);
  }
  window.__sfLocatorsFor = locatorsFor; // used by tests

  function describe(el) {
    const role = implicitRole(el);
    return `${role || el.tagName.toLowerCase()} ${JSON.stringify(accessibleName(el) || el.getAttribute('name') || '').slice(0, 60)}`;
  }

  function secretKeyFor(el) {
    const raw = el.getAttribute('name') || el.id || el.getAttribute('autocomplete') || 'password';
    const words = raw
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
    const key = words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
      .join('');
    return /^[A-Za-z_]/.test(key) ? key : `secret${key}`;
  }

  // ─── Toolbar (top frame only, inside a Shadow DOM) ─────────────────────
  let mode = 'record'; // record | assert | extract | mask
  let state = { recording: true, paused: false, steps: 0 };
  const masked = new WeakSet();
  let host, root, overlay, panel;

  function ours(e) {
    return host && e.composedPath().includes(host);
  }

  function buildToolbar() {
    if (!isTop || host) return;
    host = document.createElement('stepforge-recorder');
    // Bottom centre by default: app navigation usually sits at the top. The grip moves it out of the way.
    host.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; bottom: 16px; left: 50%; transform: translateX(-50%);';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{display:flex;flex-direction:column-reverse;align-items:center}
        :host(.below){flex-direction:column}
        .grip{cursor:grab;color:#5b6375;padding:4px 2px 4px 4px;font:14px/1 system-ui;user-select:none;touch-action:none}
        .grip:active{cursor:grabbing}
        .bar{display:flex;align-items:center;gap:4px;padding:6px;border-radius:12px;background:#0B0D12;color:#e7e9ee;font:12px/1 Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35),0 0 0 1px rgba(249,115,22,.4)}
        button,select{all:unset;cursor:pointer;padding:7px 10px;border-radius:8px;color:#e7e9ee}
        button:hover,select:hover{background:rgba(255,255,255,.08)}
        button[aria-pressed=true]{background:rgba(249,115,22,.22);color:#FDBA74}
        .dot{width:9px;height:9px;border-radius:50%;background:#EF4444;margin:0 6px 0 4px;animation:p 1.2s infinite}
        .paused .dot{background:#EAB308;animation:none}
        @keyframes p{50%{opacity:.35}}
        .count{color:#8b93a7;padding:0 6px}
        .stop{background:#F97316;color:#fff;font-weight:600}.stop:hover{background:#fb923c}
        .panel{margin:6px 0;padding:10px;border-radius:12px;background:#0B0D12;color:#e7e9ee;font:12px Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);display:none;max-width:420px}
        .panel.open{display:block}.panel b{display:block;margin-bottom:8px;color:#FDBA74}
        .panel button{display:block;width:calc(100% - 20px);margin:2px 0;background:rgba(255,255,255,.04)}
        .panel input{all:unset;display:block;width:calc(100% - 16px);padding:7px 8px;margin:6px 0;border-radius:6px;background:#161a23;color:#fff}
      </style>
      <div class="bar" part="bar">
        <span class="grip" title="Drag to move the toolbar" aria-hidden="true">⠿</span>
        <span class="dot" title="Recording"></span>
        <button data-cmd="pause" title="Pause / resume recording">Pause</button>
        <button data-mode="assert" title="Click an element to add a check">Assert</button>
        <button data-mode="extract" title="Click an element to save its text in a variable">Extract</button>
        <button data-mode="mask" title="Click a field to store what you type as a secret">Mask</button>
        <select data-cmd="insert" title="Insert a step"><option value="">Insert…</option><option value="api.request">API request</option><option value="db.query">DB query</option><option value="email.waitForEmail">Wait for email</option><option value="util.log">Note</option><option value="util.wait">Wait 1 s</option></select>
        <button data-cmd="undo" title="Remove the last step">Undo</button>
        <span class="count">0 steps</span>
        <button class="stop" data-cmd="stop" title="Stop and review">Stop</button>
      </div>
      <div class="panel"></div>`;
    overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;pointer-events:none;border:2px solid #F97316;background:rgba(249,115,22,.12);border-radius:4px;display:none;z-index:2147483646;';
    root.appendChild(overlay);
    panel = root.querySelector('.panel');
    root
      .querySelectorAll('[data-mode]')
      .forEach((b) =>
        b.addEventListener('click', () => setMode(mode === b.dataset.mode ? 'record' : b.dataset.mode)),
      );
    root
      .querySelector('[data-cmd=pause]')
      .addEventListener('click', () => command(state.paused ? 'resume' : 'pause'));
    root.querySelector('[data-cmd=undo]').addEventListener('click', () => command('undo'));
    root.querySelector('[data-cmd=stop]').addEventListener('click', () => command('stop'));
    root.querySelector('[data-cmd=insert]').addEventListener('change', (e) => {
      if (e.target.value) emit({ kind: 'insert', stepType: e.target.value }).then(refresh);
      e.target.value = '';
    });
    enableDrag(root.querySelector('.grip'));
    (document.body || document.documentElement).appendChild(host);
    refresh();
  }

  /** Drag the toolbar by its grip; the panel opens below it in the top half of the window, above it otherwise. */
  function enableDrag(grip) {
    let start = null;
    grip.addEventListener('pointerdown', (e) => {
      const r = host.getBoundingClientRect();
      start = { x: e.clientX - r.left, y: e.clientY - r.top };
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start) return;
      const r = host.getBoundingClientRect();
      const left = Math.min(Math.max(0, e.clientX - start.x), window.innerWidth - r.width);
      const top = Math.min(Math.max(0, e.clientY - start.y), window.innerHeight - r.height);
      Object.assign(host.style, { left: `${left}px`, top: `${top}px`, bottom: 'auto', transform: 'none' });
      host.classList.toggle('below', top < window.innerHeight / 2);
    });
    const end = () => {
      start = null;
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  function render() {
    if (!root) return;
    root.querySelector('.bar').classList.toggle('paused', state.paused);
    root.querySelector('[data-cmd=pause]').textContent = state.paused ? 'Resume' : 'Pause';
    root.querySelector('.count').textContent = `${state.steps} step${state.steps === 1 ? '' : 's'}`;
    root
      .querySelectorAll('[data-mode]')
      .forEach((b) => b.setAttribute('aria-pressed', String(mode === b.dataset.mode)));
  }

  function refresh() {
    emit({ kind: 'state' }).then((s) => {
      if (s) state = s;
      render();
    });
  }

  function command(cmd) {
    flushFill();
    emit({ kind: 'control', command: cmd }).then(refresh);
  }

  function setMode(m) {
    mode = m;
    overlay.style.display = 'none';
    closePanel();
    render();
  }

  function closePanel() {
    if (panel) {
      panel.className = 'panel';
      panel.innerHTML = '';
    }
  }

  function openPanel(html) {
    panel.innerHTML = html;
    panel.className = 'panel open';
  }

  // ─── Event capture ─────────────────────────────────────────────────────
  let pendingFill = null; // { el, timer }
  let lastEnterAt = 0;
  const TEXT_INPUT = /^(|text|email|password|search|tel|url|number|date|datetime-local|month|week|time)$/;
  const isTextField = (el) =>
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable ||
    (el.tagName === 'INPUT' && TEXT_INPUT.test((el.getAttribute('type') || '').toLowerCase()));

  function recording() {
    return state.recording && !state.paused;
  }

  function sendAction(action, el, extra = {}) {
    if (!recording()) return Promise.resolve();
    return emit({ kind: 'action', action, locators: locatorsFor(el), describe: describe(el), ...extra }).then(
      refresh,
    );
  }

  function flushFill() {
    if (!pendingFill) return;
    const { el } = pendingFill;
    clearTimeout(pendingFill.timer);
    pendingFill = null;
    const isSecret = (el.getAttribute('type') || '').toLowerCase() === 'password' || masked.has(el);
    if (isSecret) {
      const key = secretKeyFor(el);
      sendAction('fill', el, { value: `{{secret.${key}}}`, secret: { key, value: el.value } });
    } else sendAction('fill', el, { value: el.isContentEditable ? el.innerText : el.value });
  }

  document.addEventListener(
    'input',
    (e) => {
      if (ours(e) || !recording()) return;
      const el = e.target;
      if (!isTextField(el)) return;
      if (pendingFill && pendingFill.el !== el) flushFill();
      if (pendingFill) clearTimeout(pendingFill.timer);
      pendingFill = { el, timer: setTimeout(flushFill, 1200) };
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      if (ours(e) || !recording()) return;
      const el = e.target;
      if (isTextField(el)) return flushFill();
      flushFill();
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions[0];
        sendAction('select', el, { value: el.value, label: opt ? norm(opt.textContent) : undefined });
      } else if (type === 'checkbox' || type === 'radio') sendAction(el.checked ? 'check' : 'uncheck', el);
      else if (type === 'file') sendAction('upload', el, { files: [...el.files].map((f) => f.name) });
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (ours(e) || !recording()) return;
      if (e.key === 'Enter' && isTextField(e.target) && e.target.tagName !== 'TEXTAREA') {
        lastEnterAt = Date.now();
        flushFill();
        sendAction('press', e.target, { key: 'Enter' });
      } else if (e.key === 'Escape') {
        flushFill();
        sendAction('press', e.target === document.body ? document.documentElement : e.target, {
          key: 'Escape',
          noLocator: true,
        });
      }
    },
    true,
  );

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!overlay || mode === 'record' || ours(e)) return;
      const el = interactiveAncestor(e.target);
      const r = el.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: 'block',
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    },
    true,
  );

  function pickAssert(el) {
    const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    const text = norm(el.innerText).slice(0, 120);
    const value = isField ? el.value : '';
    const options = [
      ['visible', 'is visible', undefined],
      ...(text
        ? [
            ['text', `text is "${text.slice(0, 40)}"`, text],
            ['textContains', 'text contains…', text],
          ]
        : []),
      ...(isField ? [['value', `value is "${value.slice(0, 40)}"`, value]] : []),
      ['urlContains', `URL contains "${location.pathname}"`, location.pathname],
      ['hidden', 'is hidden', undefined],
    ];
    openPanel(
      `<b>Add a check on ${describe(el).replace(/</g, '&lt;')}</b>${options.map((o, i) => `<button data-i="${i}">${o[1].replace(/</g, '&lt;')}</button>`).join('')}<input placeholder="Expected text (for contains)" value="${text.replace(/"/g, '&quot;')}">`,
    );
    panel.querySelectorAll('button[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        const [check, , expected] = options[Number(b.dataset.i)];
        const exp = check === 'textContains' ? panel.querySelector('input').value : expected;
        const noLocator = check === 'urlContains';
        emit({ kind: 'assert', check, expected: exp, locators: noLocator ? [] : locatorsFor(el) }).then(
          refresh,
        );
        setMode('record');
      }),
    );
  }

  function pickExtract(el) {
    openPanel(
      `<b>Save the text of ${describe(el).replace(/</g, '&lt;')}</b><input placeholder="Variable name, e.g. patientCode" value="value"><button data-save>Save as variable</button>`,
    );
    const input = panel.querySelector('input');
    input.select();
    panel.querySelector('[data-save]').addEventListener('click', () => {
      const name = input.value.replace(/[^A-Za-z0-9_]/g, '') || 'value';
      const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      emit({
        kind: 'extract',
        from: isField ? 'value' : 'text',
        varName: name,
        locators: locatorsFor(el),
      }).then(refresh);
      setMode('record');
    });
  }

  document.addEventListener(
    'click',
    (e) => {
      if (ours(e)) return;
      const el = interactiveAncestor(e.target);
      if (mode !== 'record' && isTop) {
        e.preventDefault();
        e.stopPropagation();
        if (mode === 'assert') return pickAssert(el);
        if (mode === 'extract') return pickExtract(el);
        if (mode === 'mask' && isTextField(el)) {
          masked.add(el);
          el.style.outline = '2px dashed #F97316';
          setMode('record');
        }
        return;
      }
      if (!recording()) return;
      // Enter in a form field makes the browser click the default submit button (detail 0): already recorded as the key press.
      if (
        e.detail === 0 &&
        Date.now() - lastEnterAt < 500 &&
        (el.type === 'submit' || el.tagName === 'BUTTON')
      )
        return;
      if (isTextField(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return; // focus clicks; fill/select record the intent
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].includes(type)) return; // recorded on change
      if (
        el.tagName === 'LABEL' &&
        el.control &&
        ['checkbox', 'radio', 'file'].includes((el.control.type || '').toLowerCase())
      )
        return;
      flushFill();
      sendAction(e.detail === 2 ? 'dblclick' : 'click', el);
    },
    true,
  );

  document.addEventListener('submit', () => flushFill(), true);
  window.addEventListener('beforeunload', () => flushFill());

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildToolbar);
  else buildToolbar();
})();
