import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShopApp } from '../src/app.ts';

const app = createShopApp({ dbFile: ':memory:' });
let admin = '';
let cashier = '';
const login = async (email: string, password: string) =>
  (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })).json()
    .token as string;
beforeAll(async () => {
  admin = await login('admin@shopdesk.test', 'Admin123!');
  cashier = await login('cashier@shopdesk.test', 'Cashier123!');
});
afterAll(() => app.close());
const as = (t: string) => ({ authorization: `Bearer ${t}` });

describe('ShopDesk demo (the features that work)', () => {
  it('logs in through the form and the API, and keeps admin-only actions for admins', async () => {
    expect((await app.inject({ url: '/' })).headers.location).toBe('/login?next=%2F');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@shopdesk.test', password: 'x' },
    });
    expect(bad.statusCode).toBe(401);
    expect(admin).toMatch(/^[0-9a-f]{48}$/);
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: as(cashier),
      payload: { sku: 'X', name: 'X', price: 1, cost: 1 },
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await app.inject({ url: '/api/products' })).statusCode).toBe(401);
  });

  it('adds a product, sells one unit and receives stock', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: as(admin),
      payload: { sku: 'SKU-T1', name: 'Test grinder', price: 80, cost: 50, stock: 10 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as number;
    const sale = await app.inject({
      method: 'POST',
      url: '/api/sales',
      headers: as(cashier),
      payload: { items: [{ product_id: id, qty: 1 }] },
    });
    expect(sale.statusCode).toBe(201);
    expect(sale.json()).toMatchObject({ total: 80, items: [{ product_id: id, qty: 1 }] });
    expect((await app.inject({ url: `/api/products/${id}`, headers: as(admin) })).json().stock).toBe(9);
    const purchase = await app.inject({
      method: 'POST',
      url: '/api/purchases',
      headers: as(admin),
      payload: { product_id: id, qty: 5 },
    });
    expect(purchase.json()).toMatchObject({ qty: 5, stock: 14 });
    expect(
      (await app.inject({ method: 'POST', url: '/api/sales', headers: as(cashier), payload: { items: [] } }))
        .statusCode,
    ).toBe(422);
  });

  it('serves its pages, the OpenAPI document and resets the data', async () => {
    const form = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'email=admin@shopdesk.test&password=Admin123!',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const cookie = String(form.headers['set-cookie']).split(';')[0]!;
    for (const url of ['/', '/products', '/products/new', '/sales/new', '/sales', '/reports'])
      expect((await app.inject({ url, headers: { cookie } })).statusCode, url).toBe(200);
    expect((await app.inject({ url: '/api/openapi.json' })).json().info.title).toBe('ShopDesk API');
    await app.inject({ method: 'POST', url: '/api/reset' });
    expect(
      (
        await app.inject({
          url: '/api/products',
          headers: as(await login('admin@shopdesk.test', 'Admin123!')),
        })
      ).json(),
    ).toHaveLength(5);
  });
});
