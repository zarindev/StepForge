/** Tiny server-rendered views. About half the interactive elements carry data-testid on purpose. */

export const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f7fb;color:#13233a}
header{background:#0f766e;color:#fff;display:flex;align-items:center;gap:24px;padding:0 24px;height:56px}
header a{color:#d1fae5;text-decoration:none}header a:hover{color:#fff}.brand{font-weight:700;color:#fff;font-size:18px}
.user{margin-left:auto;font-size:13px}main{max-width:1000px;margin:28px auto;padding:0 20px}
.card{background:#fff;border:1px solid #dbe4ee;border-radius:10px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 16px}label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input,select,textarea{width:100%;padding:9px 10px;border:1px solid #c3cfdc;border-radius:6px;font:inherit}
button,.btn{background:#0f766e;color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary{background:#e2e8f0;color:#13233a}button.danger{background:#b91c1c}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #e5ecf3}th{font-size:12px;color:#5b6b80;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.kpi{font-size:28px;font-weight:700}
.error{background:#fee2e2;color:#991b1b;padding:10px 12px;border-radius:6px;margin-bottom:12px}
.flash{background:#dcfce7;color:#166534;padding:10px 12px;border-radius:6px;margin-bottom:12px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.muted{color:#5b6b80;font-size:13px}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px}.toolbar input{max-width:320px}
`;

export type ViewUser = { name: string; role: string } | null;

export function layout(title: string, body: string, user: ViewUser, flash?: string): string {
  const nav = user
    ? `<a href="/" data-testid="nav-dashboard">Dashboard</a><a href="/patients">Patients</a><a href="/appointments" data-testid="nav-appointments">Appointments</a>
       <span class="user">Signed in as <strong id="current-user">${esc(user.name)}</strong> (${esc(user.role)}) · <a href="/logout">Sign out</a></span>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · CareClinic</title><style>${CSS}</style></head>
<body><header><span class="brand">CareClinic</span>${nav}</header><main>
${flash ? `<div class="flash" role="status" data-testid="flash">${esc(flash)}</div>` : ''}${body}</main></body></html>`;
}

export function loginView(error?: string, email = ''): string {
  return `<div class="card" style="max-width:420px;margin:40px auto">
<h1>Sign in to CareClinic</h1>
${error ? `<div class="error" role="alert" data-testid="login-error">${esc(error)}</div>` : ''}
<form method="post" action="/login">
  <label for="email">Email</label><input id="email" name="email" type="email" value="${esc(email)}" placeholder="you@careclinic.test" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" data-testid="password" autocomplete="current-password">
  <p><button type="submit" data-testid="login-submit">Sign in</button></p>
</form>
<p class="muted">New here? <a href="/signup">Create an account</a></p>
<p class="muted">Demo accounts: admin@careclinic.test / Admin123! · reception@careclinic.test / Reception123!</p></div>`;
}
