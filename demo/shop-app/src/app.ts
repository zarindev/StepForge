import formbody from '@fastify/formbody';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { DEMO_CREDENTIALS, hash, openShopDb, seed, token } from './db.ts';
import { SHOP_OPENAPI } from './openapi.ts';
import { esc, layout, loginView, money } from './views.ts';

/**
 * ShopDesk — a small shop back office (products, stock, sales, purchases, profit). Like CareClinic it carries planted
 * bugs at every layer, listed in demo/manifests/planted_bugs.json (which StepForge never reads).
 */
type User = { id: number; email: string; name: string; role: 'admin' | 'cashier' };
type Product = { id: number; sku: string; name: string; price: number; cost: number; stock: number };

export { DEMO_CREDENTIALS };

const cookie = (req: FastifyRequest, name: string) =>
  req.headers.cookie
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createShopApp(opts: { dbFile: string; logger?: boolean }) {
  const db: Database.Database = openShopDb(opts.dbFile);
  const app = Fastify({ logger: opts.logger ?? false });
  app.register(formbody);

  const userByToken = (t: string | undefined) =>
    t
      ? (db
          .prepare(
            'SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
          )
          .get(t) as User | undefined)
      : undefined;
  const sessionUser = (req: FastifyRequest) => userByToken(cookie(req, 'sd_session'));
  const apiUser = (req: FastifyRequest) =>
    userByToken(req.headers.authorization?.replace(/^Bearer\s+/i, '')) ?? sessionUser(req);
  const page = (reply: FastifyReply, title: string, body: string, user: User | undefined, flash?: string) =>
    reply
      .type('text/html')
      .send(layout(title, body, user ? { name: user.name, role: user.role } : null, flash));
  const requireUser = (req: FastifyRequest, reply: FastifyReply) => {
    const u = sessionUser(req);
    if (!u) void reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    return u;
  };
  const login = (email: unknown, password: unknown) => {
    if (typeof email !== 'string' || typeof password !== 'string') return undefined;
    const u = db
      .prepare('SELECT id FROM users WHERE email = ? AND password_hash = ?')
      .get(email.trim().toLowerCase(), hash(password)) as { id: number } | undefined;
    if (!u) return undefined;
    const t = token();
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
      t,
      u.id,
      new Date().toISOString(),
    );
    return t;
  };
  const products = (q = '') =>
    db
      .prepare('SELECT * FROM products WHERE name LIKE ? OR sku LIKE ? ORDER BY id')
      .all(`%${q}%`, `%${q}%`) as Product[];
  const product = (id: unknown) =>
    db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Product | undefined;

  const validateProduct = (b: Record<string, unknown>): string | undefined => {
    if (!String(b.sku ?? '').trim()) return 'SKU is required';
    if (!(Number(b.price) > 0)) return 'Price must be greater than 0';
    if (!(Number(b.cost) >= 0)) return 'Cost must be 0 or more';
    if (!Number.isInteger(Number(b.stock ?? 0)) || Number(b.stock ?? 0) < 0)
      return 'Stock must be a whole number, 0 or more';
    if (db.prepare('SELECT 1 FROM products WHERE sku = ?').get(String(b.sku).trim()))
      return 'A product with this SKU exists';
    // PLANTED BUG SD-API-01: a missing product name is not rejected (the API documents 422); the product is saved
    // as "Unnamed" and the API answers 200.
    return undefined;
  };
  const createProduct = (b: Record<string, unknown>) => {
    const info = db
      .prepare('INSERT INTO products (sku, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)')
      .run(
        String(b.sku).trim(),
        String(b.name ?? '').trim() || 'Unnamed',
        Number(b.price),
        Number(b.cost),
        Number(b.stock ?? 0),
      );
    return product(info.lastInsertRowid)!;
  };

  /** A sale: stock goes down by the quantity sold. */
  const createSale = (
    items: { product_id: unknown; qty: unknown }[],
    cashierId: number,
  ): { error?: string; sale?: Record<string, unknown> } => {
    if (!Array.isArray(items) || items.length === 0) return { error: 'A sale needs at least one item' };
    const lines: { p: Product; qty: number }[] = [];
    for (const i of items) {
      const p = product(i.product_id);
      const qty = Number(i.qty);
      if (!p) return { error: `Unknown product ${String(i.product_id)}` };
      if (!Number.isInteger(qty) || qty < 1) return { error: 'Quantity must be a whole number, 1 or more' };
      // PLANTED BUG SD-DB-01: no stock check — selling more than is in stock is accepted and stock goes negative.
      lines.push({ p, qty });
    }
    // PLANTED BUG SD-BIZ-02: the sale total ignores the quantity (adds each unit price once).
    const total = lines.reduce((t, l) => t + l.p.price, 0);
    const saleId = db.transaction(() => {
      const id = db
        .prepare('INSERT INTO sales (cashier_id, total, created_at) VALUES (?, ?, ?)')
        .run(cashierId, total, new Date().toISOString()).lastInsertRowid;
      for (const l of lines) {
        db.prepare('INSERT INTO sale_items (sale_id, product_id, qty, price) VALUES (?, ?, ?, ?)').run(
          id,
          l.p.id,
          l.qty,
          l.p.price,
        );
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(l.qty, l.p.id);
      }
      return id;
    })();
    return {
      sale: {
        id: Number(saleId),
        total: Math.round(total * 100) / 100,
        items: lines.map((l) => ({ product_id: l.p.id, sku: l.p.sku, qty: l.qty, price: l.p.price })),
      },
    };
  };

  const profitReport = () => {
    const rows = db
      .prepare(
        'SELECT p.sku, p.name, SUM(i.qty) qty, SUM(i.qty * i.price) revenue, SUM(i.qty * i.price) cogs FROM sale_items i JOIN products p ON p.id = i.product_id GROUP BY p.id ORDER BY p.id',
      )
      .all() as { sku: string; name: string; qty: number; revenue: number; cogs: number }[];
    // PLANTED BUG SD-BIZ-01: the cost of goods sold uses the selling price instead of the unit cost, so profit is
    // always 0 (profit should be revenue − qty × cost).
    const lines = rows.map((r) => ({ ...r, profit: Math.round((r.revenue - r.cogs) * 100) / 100 }));
    const sum = (k: 'revenue' | 'cogs' | 'profit') =>
      Math.round(lines.reduce((t, l) => t + l[k], 0) * 100) / 100;
    return { lines, revenue: sum('revenue'), cogs: sum('cogs'), profit: sum('profit') };
  };

  // ─── UI ────────────────────────────────────────────────────────────────
  app.get('/login', async (_req, reply) => page(reply, 'Sign in', loginView(), undefined));
  app.post<{ Body: { email?: string; password?: string }; Querystring: { next?: string } }>(
    '/login',
    async (req, reply) => {
      const t = login(req.body.email, req.body.password);
      if (!t)
        return reply
          .code(401)
          .type('text/html')
          .send(layout('Sign in', loginView('Invalid email or password', req.body.email), null));
      const next = req.query.next?.startsWith('/') ? req.query.next : '/';
      return reply.header('set-cookie', `sd_session=${t}; Path=/; HttpOnly; SameSite=Lax`).redirect(next);
    },
  );
  app.get('/logout', async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(cookie(req, 'sd_session') ?? '');
    return reply.header('set-cookie', 'sd_session=; Path=/; Max-Age=0').redirect('/login');
  });

  app.get('/', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return page(
      reply,
      'Dashboard',
      `<h1>Hello, ${esc(u.name)}</h1><div class="grid">
      <div class="card"><div class="muted">Products</div><div class="kpi" data-testid="kpi-products">${n('SELECT COUNT(*) n FROM products')}</div></div>
      <div class="card"><div class="muted">Out of stock</div><div class="kpi" id="kpi-out">${n('SELECT COUNT(*) n FROM products WHERE stock <= 0')}</div></div>
      <div class="card"><div class="muted">Sales</div><div class="kpi">${n('SELECT COUNT(*) n FROM sales')}</div></div></div>
      <p><a class="btn" href="/sales/new" data-testid="quick-sale">New sale</a> ${u.role === 'admin' ? '<a class="btn" href="/products/new">Add product</a>' : ''}</p>`,
      u,
    );
  });

  // PLANTED BUG SD-UI-01: a product with 0 in stock is shown as "In stock" (should be "Out of stock").
  const badge = (stock: number) =>
    stock < 0 || (stock > 0 && stock >= 5)
      ? '<span class="badge ok">In stock</span>'
      : stock > 0
        ? '<span class="badge low">Low stock</span>'
        : '<span class="badge ok">In stock</span>';
  app.get<{ Querystring: { q?: string; flash?: string } }>('/products', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const q = (req.query.q ?? '').trim();
    const rows = products(q);
    return page(
      reply,
      'Products',
      `<h1>Products</h1><div class="card">
      <form class="toolbar" method="get" action="/products"><input name="q" value="${esc(q)}" placeholder="Search by name or SKU" aria-label="Search products" data-testid="product-search">
      <button type="submit" class="secondary">Search</button>${u.role === 'admin' ? '<a class="btn" href="/products/new" style="margin-left:auto" data-testid="new-product">Add product</a>' : ''}</form>
      <table data-testid="products-table"><thead><tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock</th><th>Status</th></tr></thead><tbody>
      ${rows.map((p) => `<tr data-sku="${esc(p.sku)}"><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${money(p.price)}</td><td class="stock">${p.stock}</td><td>${badge(p.stock)}</td></tr>`).join('')}
      </tbody></table>${rows.length === 0 ? '<p class="muted" data-testid="no-products">No products found.</p>' : ''}</div>`,
      u,
      req.query.flash,
    );
  });
  const productForm = (
    b: Record<string, string | undefined> = {},
    error?: string,
  ) => `<h1>Add a product</h1><div class="card">
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/products">
      <label for="name">Product name</label><input id="name" name="name" value="${esc(b.name)}">
      <label for="sku">SKU</label><input id="sku" name="sku" value="${esc(b.sku)}" data-testid="product-sku">
      <div class="row"><div><label for="price">Price</label><input id="price" name="price" value="${esc(b.price)}" inputmode="decimal"></div>
      <div><label for="cost">Unit cost</label><input id="cost" name="cost" value="${esc(b.cost)}" inputmode="decimal" data-testid="product-cost"></div>
      <div><label for="stock">Opening stock</label><input id="stock" name="stock" value="${esc(b.stock ?? '0')}" inputmode="numeric"></div></div>
      <p><button type="submit" data-testid="save-product">Save product</button> <a href="/products">Cancel</a></p>
    </form></div>`;
  app.get('/products/new', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    if (u.role !== 'admin')
      return page(reply.code(403), 'Forbidden', '<h1>Only admins can add products</h1>', u);
    return page(reply, 'Add product', productForm(), u);
  });
  app.post<{ Body: Record<string, string> }>('/products', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    if (u.role !== 'admin')
      return page(reply.code(403), 'Forbidden', '<h1>Only admins can add products</h1>', u);
    const error = validateProduct(req.body);
    if (error) return page(reply.code(422), 'Add product', productForm(req.body, error), u);
    const p = createProduct(req.body);
    return reply.redirect(
      `/products?q=${encodeURIComponent(p.sku)}&flash=${encodeURIComponent(`Product ${p.sku} added`)}`,
    );
  });

  // Point of sale. PLANTED BUG SD-UI-03: the running total reads line.unitPrice (undefined) and throws a TypeError, so
  // the displayed total stays at 0.00 (the sale itself still goes through).
  // PLANTED BUG SD-UI-02: on narrow screens (≤ 600 px) a "rate us" sheet covers the page and cannot be dismissed, so
  // "Complete sale" cannot be clicked on mobile.
  app.get('/sales/new', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const options = products()
      .map(
        (p) =>
          `<option value="${p.id}" data-price="${p.price}">${esc(p.name)} (${esc(p.sku)}) — ${money(p.price)}</option>`,
      )
      .join('');
    return page(
      reply,
      'New sale',
      `<h1>New sale</h1><div class="card">
      <div class="row"><div><label for="product">Product</label><select id="product" data-testid="sale-product">${options}</select></div>
      <div><label for="qty">Quantity</label><input id="qty" value="1" inputmode="numeric" data-testid="sale-qty"></div>
      <div style="align-self:end"><button type="button" id="add-line" class="secondary">Add to cart</button></div></div>
      <table style="margin-top:16px"><thead><tr><th>Product</th><th>Qty</th><th>Price</th></tr></thead><tbody id="cart"></tbody></table>
      <p>Total: <span class="total" data-testid="cart-total">0.00</span></p>
      <form method="post" action="/sales"><input type="hidden" name="cart" id="cart-json" value="[]">
      <button type="submit" data-testid="complete-sale">Complete sale</button></form></div>
      <style>.rate-sheet{display:none}@media (max-width:600px){.rate-sheet{display:block;position:fixed;inset:56px 0 0 0;background:rgba(124,45,18,.96);color:#fff;padding:40px 24px;z-index:50}}</style>
      <div class="rate-sheet"><h2>Enjoying ShopDesk?</h2><p>Rate us in the app store.</p><button type="button" class="secondary" onclick="void 0">Later</button></div>
      <script>
        const lines = [];
        document.getElementById('add-line').addEventListener('click', () => {
          const sel = document.getElementById('product');
          const opt = sel.options[sel.selectedIndex];
          const qty = Number(document.getElementById('qty').value) || 1;
          lines.push({ product_id: Number(sel.value), name: opt.textContent, qty, price: Number(opt.dataset.price) });
          document.getElementById('cart').innerHTML = lines.map((l) => '<tr><td>' + l.name + '</td><td>' + l.qty + '</td><td>' + l.price.toFixed(2) + '</td></tr>').join('');
          document.getElementById('cart-json').value = JSON.stringify(lines.map((l) => ({ product_id: l.product_id, qty: l.qty })));
          const total = lines.reduce((t, l) => t + l.qty * l.unitPrice.toFixed(2), 0);
          document.querySelector('[data-testid="cart-total"]').textContent = total.toFixed(2);
        });
      </script>`,
      u,
    );
  });
  app.post<{ Body: { cart?: string } }>('/sales', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    let items: { product_id: unknown; qty: unknown }[] = [];
    try {
      items = JSON.parse(req.body.cart ?? '[]');
    } catch {
      // empty cart
    }
    const r = createSale(items, u.id);
    if (r.error) return reply.redirect(`/sales/new`);
    return reply.redirect(
      `/sales?flash=${encodeURIComponent(`Sale #${r.sale!.id} completed — total ${money(Number(r.sale!.total))}`)}`,
    );
  });
  app.get<{ Querystring: { flash?: string } }>('/sales', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const rows = db
      .prepare(
        'SELECT s.id, s.total, s.created_at, u.name cashier FROM sales s JOIN users u ON u.id = s.cashier_id ORDER BY s.id DESC LIMIT 50',
      )
      .all() as {
      id: number;
      total: number;
      created_at: string;
      cashier: string;
    }[];
    return page(
      reply,
      'Sales',
      `<h1>Sales</h1><div class="card"><table id="sales-table"><thead><tr><th>#</th><th>Date</th><th>Cashier</th><th>Total</th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td>${s.id}</td><td>${esc(s.created_at.slice(0, 16).replace('T', ' '))}</td><td>${esc(s.cashier)}</td><td>${money(s.total)}</td></tr>`).join('')}
      </tbody></table></div>`,
      u,
      req.query.flash,
    );
  });
  app.get('/reports', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const r = profitReport();
    return page(
      reply,
      'Reports',
      `<h1>Profit report</h1><div class="card"><table><thead><tr><th>SKU</th><th>Product</th><th>Sold</th><th>Revenue</th><th>Cost of goods</th><th>Profit</th></tr></thead><tbody>
      ${r.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td>${l.qty}</td><td>${money(l.revenue)}</td><td>${money(l.cogs)}</td><td>${money(l.profit)}</td></tr>`).join('')}
      </tbody></table><p>Total profit: <strong data-testid="profit-total">${money(r.profit)}</strong></p></div>`,
      u,
    );
  });

  // ─── REST API ───────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, app: 'ShopDesk' }));
  app.get('/api/openapi.json', async () => SHOP_OPENAPI);
  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const t = login(req.body?.email, req.body?.password);
    if (!t)
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid email or password' });
    return { token: t, user: userByToken(t) };
  });
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (
      !path.startsWith('/api/') ||
      ['/api/health', '/api/auth/login', '/api/reset', '/api/openapi.json'].includes(path)
    )
      return;
    // PLANTED BUG SD-API-03: the profit report skips the auth check (documented: admins only).
    if (path === '/api/reports/profit') return;
    const u = apiUser(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized', message: 'Login required' });
    (req as FastifyRequest & { user?: User }).user = u;
  });
  const user = (req: FastifyRequest) => (req as FastifyRequest & { user: User }).user;
  const adminOnly = (req: FastifyRequest, reply: FastifyReply) => {
    if (user(req).role !== 'admin') {
      void reply.code(403).send({ error: 'forbidden', message: 'Only admins can do this' });
      return false;
    }
    return true;
  };

  // PLANTED BUG SD-API-02: prices are serialised as strings, violating the documented schema (number).
  const apiProduct = (p: Product) => ({ ...p, price: p.price.toFixed(2), cost: p.cost.toFixed(2) });
  app.get<{ Querystring: { q?: string } }>('/api/products', async (req) =>
    products(req.query.q ?? '').map(apiProduct),
  );
  app.get<{ Params: { id: string } }>('/api/products/:id', async (req, reply) => {
    const p = product(req.params.id);
    return p ? apiProduct(p) : reply.code(404).send({ error: 'not_found', message: 'Product not found' });
  });
  app.post<{ Body: Record<string, unknown> }>('/api/products', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const body = req.body ?? {};
    const error = validateProduct(body);
    if (error) return reply.code(422).send({ error: 'validation_error', message: error });
    const p = createProduct(body);
    return reply.code(body.name ? 201 : 200).send(apiProduct(p));
  });
  app.delete<{ Params: { id: string } }>('/api/products/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    if (!product(req.params.id))
      return reply.code(404).send({ error: 'not_found', message: 'Product not found' });
    // PLANTED BUG SD-DB-02: the product's sale lines are left behind, pointing at a product that no longer exists.
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Body: { items?: { product_id: unknown; qty: unknown }[] } }>(
    '/api/sales',
    async (req, reply) => {
      const r = createSale(req.body?.items ?? [], user(req).id);
      if (r.error) return reply.code(422).send({ error: 'validation_error', message: r.error });
      return reply.code(201).send(r.sale);
    },
  );
  // PLANTED BUG SD-PERF-02: ?expand=items loads every sale's lines with one query per sale and one per line (N+1);
  // each query costs ~40 ms like a remote database round trip would.
  app.get<{ Querystring: { expand?: string } }>('/api/sales', async (req) => {
    const sales = db.prepare('SELECT * FROM sales ORDER BY id DESC LIMIT 20').all() as {
      id: number;
      total: number;
      created_at: string;
    }[];
    if (req.query.expand !== 'items') return sales;
    const out = [];
    for (const s of sales) {
      await sleep(40);
      const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id) as {
        product_id: number;
        qty: number;
        price: number;
      }[];
      const lines = [];
      for (const i of items) {
        await sleep(40);
        lines.push({
          ...i,
          product:
            (
              db.prepare('SELECT name FROM products WHERE id = ?').get(i.product_id) as
                { name: string } | undefined
            )?.name ?? null,
        });
      }
      out.push({ ...s, items: lines });
    }
    return out;
  });
  app.post<{ Body: { product_id?: unknown; qty?: unknown; cost?: unknown } }>(
    '/api/purchases',
    async (req, reply) => {
      if (!adminOnly(req, reply)) return;
      const p = product(req.body?.product_id);
      const qty = Number(req.body?.qty);
      const cost = Number(req.body?.cost ?? p?.cost);
      if (!p) return reply.code(422).send({ error: 'validation_error', message: 'Unknown product' });
      if (!Number.isInteger(qty) || qty < 1)
        return reply
          .code(422)
          .send({ error: 'validation_error', message: 'Quantity must be a whole number, 1 or more' });
      const id = db.transaction(() => {
        const r = db
          .prepare('INSERT INTO purchases (product_id, qty, cost, created_at) VALUES (?, ?, ?, ?)')
          .run(p.id, qty, cost, new Date().toISOString());
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(qty, p.id);
        return Number(r.lastInsertRowid);
      })();
      return reply.code(201).send({ id, product_id: p.id, qty, cost, stock: product(p.id)!.stock });
    },
  );
  app.get('/api/reports/profit', async () => profitReport());
  // PLANTED BUG SD-PERF-01: the sales report is deliberately slow (about 1.5 s).
  app.get('/api/reports/sales', async () => {
    await sleep(1500);
    return db
      .prepare(
        'SELECT substr(created_at, 1, 10) day, COUNT(*) sales, ROUND(SUM(total), 2) total FROM sales GROUP BY day ORDER BY day',
      )
      .all();
  });
  // Resets the demo data set (used by tests and the StepForge demo workspace). Local demo only.
  app.post('/api/reset', async () => {
    seed(db);
    return { ok: true };
  });

  app.addHook('onClose', async () => db.close());
  return app;
}
