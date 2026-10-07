/** Tiny server-rendered views for ShopDesk. About half the interactive elements carry data-testid on purpose. */

export const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const money = (n: number) => n.toFixed(2);

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:#f7f5f2;color:#1f1a14}
header{background:#7c2d12;color:#fff;display:flex;align-items:center;gap:24px;padding:0 24px;height:56px}
header a{color:#fed7aa;text-decoration:none}header a:hover{color:#fff}.brand{font-weight:700;color:#fff;font-size:18px}
.user{margin-left:auto;font-size:13px}main{max-width:1000px;margin:28px auto;padding:0 20px}
.card{background:#fff;border:1px solid #e7e0d8;border-radius:10px;padding:20px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 16px}label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
input,select{width:100%;padding:9px 10px;border:1px solid #d6cbbf;border-radius:6px;font:inherit}
button,.btn{background:#c2410c;color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button.secondary{background:#ede4da;color:#1f1a14}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #eee6dd}th{font-size:12px;color:#7a6a5a;text-transform:uppercase}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.kpi{font-size:28px;font-weight:700}
.error{background:#fee2e2;color:#991b1b;padding:10px 12px;border-radius:6px;margin-bottom:12px}
.flash{background:#dcfce7;color:#166534;padding:10px 12px;border-radius:6px;margin-bottom:12px}
.row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}.muted{color:#7a6a5a;font-size:13px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
.ok{background:#dcfce7;color:#166534}.low{background:#fef3c7;color:#92400e}.out{background:#fee2e2;color:#991b1b}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px}.toolbar input{max-width:320px}
.total{font-size:24px;font-weight:700}
`;

export type ViewUser = { name: string; role: string } | null;

export function layout(title: string, body: string, user: ViewUser, flash?: string): string {
  const nav = user
    ? `<a href="/" data-testid="nav-dashboard">Dashboard</a><a href="/products">Products</a><a href="/sales/new" data-testid="nav-pos">New sale</a><a href="/sales">Sales</a>${user.role === 'admin' ? '<a href="/reports">Reports</a>' : ''}
       <span class="user">Signed in as <strong id="current-user">${esc(user.name)}</strong> (${esc(user.role)}) · <a href="/logout">Sign out</a></span>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ShopDesk</title><style>${CSS}</style></head>
<body><header><span class="brand">ShopDesk</span>${nav}</header><main>
${flash ? `<div class="flash" role="status" data-testid="flash">${esc(flash)}</div>` : ''}${body}</main></body></html>`;
}

export function loginView(error?: string, email = ''): string {
  return `<div class="card" style="max-width:420px;margin:40px auto">
<h1>Sign in to ShopDesk</h1>
${error ? `<div class="error" role="alert" data-testid="login-error">${esc(error)}</div>` : ''}
<form method="post" action="/login">
  <label for="email">Email</label><input id="email" name="email" type="email" value="${esc(email)}" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" data-testid="password" autocomplete="current-password">
  <p><button type="submit">Sign in</button></p>
</form>
<p class="muted">Demo accounts: admin@shopdesk.test / Admin123! · cashier@shopdesk.test / Cashier123!</p></div>`;
}
