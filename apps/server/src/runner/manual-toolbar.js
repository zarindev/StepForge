// StepForge manual testing panel — injected into the browser a tester uses for a manual test (by Md Zarin Tasnim).
// It shows the current step, what to expect and the next step, and sends the tester's actions to StepForge through
// the `__sfManual` binding: mark a step, take a screenshot, record a clip, jump to a step, finish.
(() => {
  if (window.top !== window || window.__sfManualPanel) return;
  window.__sfManualPanel = true;

  const css = `
  :host { all: initial; }
  .panel { position: fixed; right: 16px; bottom: 16px; width: 360px; z-index: 2147483647; font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
    color: #F5F7FA; background: #11151f; border: 1px solid rgba(255,255,255,.14); border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.45); overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: #171b26; cursor: move; user-select: none; }
  .brand { font-weight: 700; color: #FB923C; }
  .count { margin-left: auto; color: #9AA4B2; font-variant-numeric: tabular-nums; }
  .icon { background: none; border: 0; color: #9AA4B2; cursor: pointer; font-size: 14px; padding: 0 2px; }
  .body { padding: 12px; display: grid; gap: 10px; }
  .num { color: #9AA4B2; font-size: 11px; }
  .step { font-size: 14px; font-weight: 600; }
  .expect { color: #A7F3D0; font-size: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  button.b { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #F5F7FA; border-radius: 8px; padding: 6px 10px;
    font: inherit; font-weight: 600; cursor: pointer; }
  button.b:hover { background: rgba(255,255,255,.12); }
  .pass { background: rgba(34,197,94,.18) !important; border-color: rgba(34,197,94,.5) !important; color: #86EFAC !important; }
  .fail { background: rgba(239,68,68,.18) !important; border-color: rgba(239,68,68,.5) !important; color: #FCA5A5 !important; }
  .block { background: rgba(251,146,60,.16) !important; border-color: rgba(251,146,60,.5) !important; color: #FDBA74 !important; }
  .rec { color: #FCA5A5 !important; }
  textarea, select { width: 100%; box-sizing: border-box; background: #0B0D12; color: #F5F7FA; border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
    padding: 6px 8px; font: inherit; }
  textarea { min-height: 46px; resize: vertical; }
  .next { color: #9AA4B2; font-size: 12px; border-top: 1px solid rgba(255,255,255,.08); padding-top: 8px; }
  .done { color: #86EFAC; font-weight: 600; }
  .toast { color: #FDBA74; font-size: 12px; min-height: 16px; }
  .min .body { display: none; }
  `;

  const host = document.createElement('stepforge-manual');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${css}</style><div class="panel" part="panel"></div>`;
  const panel = root.querySelector('.panel');
  let state = null;
  let note = '';
  let message = '';

  const send = async (action) => {
    try {
      const next = await window.__sfManual(action);
      if (next) state = next;
    } catch (e) {
      message = String((e && e.message) || e);
    }
    render();
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const split = (text) => {
    const i = text.indexOf(' — expect: ');
    return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + 11)];
  };

  function render() {
    if (!state) {
      panel.innerHTML = `<div class="head"><span class="brand">StepForge</span><span class="count">loading…</span></div>`;
      return;
    }
    const cur = state.lines.find((l) => l.number === state.current);
    const steps = state.lines.filter((l) => !l.group);
    const doneCount = steps.filter((l) => l.status && l.status !== 'pending').length;
    const nextLine = cur ? steps[steps.indexOf(cur) + 1] : undefined;
    const [what, expect] = cur ? split(cur.text) : ['', ''];
    const mark = (status, label, cls) =>
      `<button class="b ${cur && cur.status === status ? cls : ''}" data-mark="${status}" aria-label="${label}">${label}</button>`;
    panel.innerHTML = `
      <div class="head" data-drag>
        <span class="brand">StepForge</span><span>Manual test</span>
        <span class="count">${doneCount} / ${steps.length}</span>
        <button class="icon" data-min aria-label="Minimise" title="Minimise">▁</button>
      </div>
      <div class="body">
        <div class="num">${esc(state.title)}</div>
        ${
          cur
            ? `<div><div class="num">Step ${esc(cur.number)}</div><div class="step">${esc(what)}</div>${expect ? `<div class="expect">Expect: ${esc(expect)}</div>` : ''}</div>
        <div class="row">${mark('passed', '✓ Pass', 'pass')}${mark('failed', '✗ Fail', 'fail')}${mark('blocked', '⊘ Blocked', 'block')}${mark('skipped', '→ Skip', '')}</div>
        <textarea data-note placeholder="What happened? (kept with the step; write the bug report in StepForge)">${esc(note)}</textarea>
        <div class="row">
          <button class="b" data-shot aria-label="Take a screenshot">📷 Screenshot${cur.screenshots ? ` (${cur.screenshots})` : ''}</button>
          <button class="b ${state.recording ? 'rec' : ''}" data-clip aria-label="${state.recording ? 'Stop the clip' : 'Record a clip'}">${state.recording ? '■ Stop clip' : '● Record clip'}</button>
        </div>`
            : `<div class="done">All steps recorded.</div>`
        }
        <select data-go aria-label="Go to step">${steps
          .map(
            (l) =>
              `<option value="${esc(l.number)}" ${cur && l.number === cur.number ? 'selected' : ''}>${esc(l.number)} ${l.status && l.status !== 'pending' ? `[${l.status}] ` : ''}${esc(split(l.text)[0]).slice(0, 60)}</option>`,
          )
          .join('')}</select>
        ${nextLine ? `<div class="next">Next: ${esc(split(nextLine.text)[0])}</div>` : ''}
        <div class="row"><button class="b" data-finish aria-label="Finish the test">Finish test</button></div>
        <div class="toast">${esc(message)}</div>
      </div>`;
    message = '';
    const ta = panel.querySelector('[data-note]');
    if (ta) ta.addEventListener('input', (e) => (note = e.target.value));
    panel.querySelectorAll('[data-mark]').forEach((b) =>
      b.addEventListener('click', () => {
        const n = note;
        note = '';
        send({ type: 'mark', number: cur.number, status: b.dataset.mark, note: n });
      }),
    );
    const on = (sel, fn) => panel.querySelector(sel)?.addEventListener('click', fn);
    on('[data-shot]', () => send({ type: 'screenshot', number: cur.number, note }));
    on('[data-clip]', () => send({ type: state.recording ? 'clipStop' : 'clipStart', number: cur.number }));
    on('[data-finish]', () => send({ type: 'finish' }));
    on('[data-min]', () => panel.classList.toggle('min'));
    panel
      .querySelector('[data-go]')
      ?.addEventListener('change', (e) => send({ type: 'go', number: e.target.value }));
    drag(panel.querySelector('[data-drag]'));
  }

  function drag(handle) {
    if (!handle) return;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (m) => {
        panel.style.left = `${Math.max(0, m.clientX - dx)}px`;
        panel.style.top = `${Math.max(0, m.clientY - dy)}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  // StepForge updates the panel when results change elsewhere (e.g. in the dashboard), and hides it for screenshots.
  window.__sfManualRender = (next) => {
    state = next;
    render();
  };
  window.__sfManualHide = (hidden) => {
    host.style.display = hidden ? 'none' : '';
  };
  const mount = () => {
    (document.body || document.documentElement).appendChild(host);
    render();
    send({ type: 'state' });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
