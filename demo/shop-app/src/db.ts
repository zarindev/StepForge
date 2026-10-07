import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = (pw: string) => createHash('sha256').update(`shopdesk:${pw}`).digest('hex');
export const token = () => randomBytes(24).toString('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, price REAL NOT NULL, cost REAL NOT NULL, stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, cashier_id INTEGER NOT NULL REFERENCES users(id), total REAL NOT NULL, created_at TEXT NOT NULL);
-- PLANTED BUG SD-DB-02 (see demo/manifests/planted_bugs.json): product_id has no foreign key.
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE, product_id INTEGER NOT NULL, qty INTEGER NOT NULL, price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, qty INTEGER NOT NULL, cost REAL NOT NULL, created_at TEXT NOT NULL);
`;

const USERS = [
  ['admin@shopdesk.test', 'Sam Admin', 'admin', 'Admin123!'],
  ['cashier@shopdesk.test', 'Casey Cashier', 'cashier', 'Cashier123!'],
] as const;
const PRODUCTS = [
  ['SKU-1001', 'Espresso beans 1 kg', 24.0, 14.0, 40],
  ['SKU-1002', 'Ceramic mug', 9.5, 3.2, 120],
  ['SKU-1003', 'Milk frother', 39.0, 21.0, 8],
  ['SKU-1004', 'Paper filters (100)', 4.5, 1.1, 0],
  ['SKU-1005', 'Gooseneck kettle', 59.0, 33.0, 3],
] as const;

export function openShopDb(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  if ((db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n === 0) seed(db);
  return db;
}

/** Restores the deterministic demo data set. */
export function seed(db: Database.Database): void {
  db.transaction(() => {
    db.exec(
      'DELETE FROM sessions; DELETE FROM sale_items; DELETE FROM sales; DELETE FROM purchases; DELETE FROM products; DELETE FROM users;',
    );
    const u = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)');
    for (const [email, name, role, pw] of USERS) u.run(email, name, role, hash(pw));
    const p = db.prepare('INSERT INTO products (sku, name, price, cost, stock) VALUES (?, ?, ?, ?, ?)');
    for (const row of PRODUCTS) p.run(...row);
    // Two earlier sales for the reports.
    const sale = db.prepare('INSERT INTO sales (cashier_id, total, created_at) VALUES (2, ?, ?)');
    const item = db.prepare('INSERT INTO sale_items (sale_id, product_id, qty, price) VALUES (?, ?, ?, ?)');
    const s1 = sale.run(33.5, '2026-10-01T10:00:00Z').lastInsertRowid;
    item.run(s1, 1, 1, 24.0);
    item.run(s1, 2, 1, 9.5);
    const s2 = sale.run(39.0, '2026-10-02T15:30:00Z').lastInsertRowid;
    item.run(s2, 3, 1, 39.0);
  })();
}

export const DEMO_CREDENTIALS = USERS.map(([email, name, role, password]) => ({
  email,
  name,
  role,
  password,
}));
