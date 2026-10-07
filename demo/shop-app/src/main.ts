import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShopApp, DEMO_CREDENTIALS } from './app.ts';

const port = Number(process.env.SHOP_PORT ?? 8102);
const dbFile = process.env.SHOP_DB ?? join(dirname(fileURLToPath(import.meta.url)), '../.data/shop.db');
const app = createShopApp({ dbFile });
await app.listen({ host: '127.0.0.1', port });
console.log(`ShopDesk demo running at http://127.0.0.1:${port}`);
for (const c of DEMO_CREDENTIALS) console.log(`  ${c.role.padEnd(8)} ${c.email} / ${c.password}`);
