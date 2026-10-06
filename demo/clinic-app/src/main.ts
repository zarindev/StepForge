import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClinicApp, DEMO_CREDENTIALS } from './app.ts';

const port = Number(process.env.CLINIC_PORT ?? 8101);
const dbFile = process.env.CLINIC_DB ?? join(dirname(fileURLToPath(import.meta.url)), '../.data/clinic.db');
const app = createClinicApp({
  dbFile,
  // Sign-up emails go to Mailpit (StepForge's local email catcher) by default.
  smtp: {
    host: process.env.CLINIC_SMTP_HOST ?? '127.0.0.1',
    port: Number(process.env.CLINIC_SMTP_PORT ?? 1025),
  },
});
await app.listen({ host: '127.0.0.1', port });
console.log(`CareClinic demo running at http://127.0.0.1:${port}`);
for (const c of DEMO_CREDENTIALS) console.log(`  ${c.role.padEnd(13)} ${c.email} / ${c.password}`);
