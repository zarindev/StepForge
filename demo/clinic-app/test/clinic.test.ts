import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClinicApp } from '../src/app.ts';

const app = createClinicApp({ dbFile: ':memory:' });
let token = '';
beforeAll(async () => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@careclinic.test', password: 'Admin123!' },
  });
  token = r.json().token;
});
afterAll(() => app.close());
const auth = () => ({ authorization: `Bearer ${token}` });

describe('CareClinic demo', () => {
  it('redirects anonymous users to login and logs in through the form', async () => {
    expect((await app.inject({ url: '/' })).headers.location).toBe('/login?next=%2F');
    const bad = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'email=admin@careclinic.test&password=nope',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'email=admin@careclinic.test&password=Admin123!',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(ok.statusCode).toBe(302);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/', headers: { cookie } })).body).toContain('Welcome, Alex Admin');
  });

  it('serves the API with auth, validation and conflicts', async () => {
    expect((await app.inject({ url: '/api/patients' })).statusCode).toBe(401);
    const list = await app.inject({ url: '/api/patients', headers: auth() });
    expect(list.json()).toHaveLength(4);
    const created = await app.inject({
      method: 'POST',
      url: '/api/patients',
      headers: auth(),
      payload: { full_name: 'Eve Park', dob: '1990-02-02', phone: '+1-555-201-0009' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().code).toBe('PAT-1005');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/patients',
          headers: auth(),
          payload: { full_name: 'X' },
        })
      ).statusCode,
    ).toBe(422);
    const clash = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: auth(),
      payload: { patient_id: 3, doctor_id: 1, date: '2026-11-02', time: '09:00' },
    });
    expect(clash.statusCode).toBe(409);
  });

  it('resets demo data', async () => {
    await app.inject({ method: 'POST', url: '/api/reset' });
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@careclinic.test', password: 'Admin123!' },
    });
    token = r.json().token;
    expect((await app.inject({ url: '/api/patients', headers: auth() })).json()).toHaveLength(4);
  });
});
