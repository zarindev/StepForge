import formbody from '@fastify/formbody';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { DEMO_CREDENTIALS, hash, openClinicDb, seed, token } from './db.ts';
import { CLINIC_OPENAPI, TIME_SLOTS } from './openapi.ts';
import { esc, layout, loginView } from './views.ts';

type User = { id: number; email: string; name: string; role: 'admin' | 'doctor' | 'receptionist' };
type Patient = {
  id: number;
  code: string;
  full_name: string;
  dob: string;
  phone: string;
  email: string | null;
  insurance: string | null;
  created_at: string;
};

export { DEMO_CREDENTIALS };

function cookie(req: FastifyRequest, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];
}

export function createClinicApp(opts: { dbFile: string; logger?: boolean }) {
  const db: Database.Database = openClinicDb(opts.dbFile);
  const app = Fastify({ logger: opts.logger ?? false });
  app.register(formbody);

  const userByToken = (t: string | undefined): User | undefined =>
    t
      ? (db
          .prepare(
            'SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
          )
          .get(t) as User | undefined)
      : undefined;
  const sessionUser = (req: FastifyRequest) => userByToken(cookie(req, 'cc_session'));
  const apiUser = (req: FastifyRequest) =>
    userByToken(req.headers.authorization?.replace(/^Bearer\s+/i, '')) ?? sessionUser(req);

  const page = (reply: FastifyReply, title: string, body: string, user: User | undefined, flash?: string) =>
    reply
      .type('text/html')
      .send(layout(title, body, user ? { name: user.name, role: user.role } : null, flash));
  const requireUser = (req: FastifyRequest, reply: FastifyReply): User | undefined => {
    const u = sessionUser(req);
    if (!u) void reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    return u;
  };
  const login = (email: unknown, password: unknown): string | undefined => {
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
  const nextPatientCode = () => {
    const row = db.prepare('SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) m FROM patients').get() as {
      m: number | null;
    };
    return `PAT-${(row.m ?? 1000) + 1}`;
  };
  const validatePatient = (b: Record<string, unknown>): string | undefined => {
    for (const k of ['full_name', 'dob', 'phone', 'email', 'insurance']) {
      if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') return `${k} must be a string`;
    }
    if (!(b.full_name as string | undefined)?.trim()) return 'Full name is required';
    if (!b.dob || !/^\d{4}-\d{2}-\d{2}$/.test(b.dob as string)) return 'Date of birth must be YYYY-MM-DD';
    if (!b.phone || !/^[+\d][\d\s-]{6,}$/.test(b.phone as string)) return 'Phone number is invalid';
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email as string)) return 'Email address is invalid';
    return undefined;
  };
  const createPatient = (b: Record<string, string | undefined>): Patient => {
    const info = db
      .prepare(
        'INSERT INTO patients (code, full_name, dob, phone, email, insurance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        nextPatientCode(),
        b.full_name!.trim(),
        b.dob,
        b.phone!.trim(),
        b.email?.trim() || null,
        b.insurance?.trim() || null,
        new Date().toISOString(),
      );
    return db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid) as Patient;
  };
  const doctors = () =>
    db.prepare('SELECT * FROM doctors ORDER BY id').all() as {
      id: number;
      name: string;
      specialty: string;
      fee: number;
    }[];

  // ─── UI ────────────────────────────────────────────────────────────────
  app.get('/login', async (req, reply) => page(reply, 'Sign in', loginView(), undefined));
  app.post<{ Body: { email?: string; password?: string }; Querystring: { next?: string } }>(
    '/login',
    async (req, reply) => {
      const t = login(req.body.email ?? '', req.body.password ?? '');
      if (!t)
        return reply
          .code(401)
          .type('text/html')
          .send(layout('Sign in', loginView('Invalid email or password', req.body.email), null));
      const next = req.query.next?.startsWith('/') ? req.query.next : '/';
      return reply.header('set-cookie', `cc_session=${t}; Path=/; HttpOnly; SameSite=Lax`).redirect(next);
    },
  );
  app.get('/logout', async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(cookie(req, 'cc_session') ?? '');
    return reply.header('set-cookie', 'cc_session=; Path=/; Max-Age=0').redirect('/login');
  });

  app.get('/', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return page(
      reply,
      'Dashboard',
      `<h1>Welcome, ${esc(u.name)}</h1><div class="grid">
       <div class="card"><div class="muted">Patients</div><div class="kpi" data-testid="kpi-patients">${n('SELECT COUNT(*) n FROM patients')}</div></div>
       <div class="card"><div class="muted">Upcoming appointments</div><div class="kpi" id="kpi-appointments">${n("SELECT COUNT(*) n FROM appointments WHERE status = 'booked'")}</div></div>
       <div class="card"><div class="muted">Doctors</div><div class="kpi">${n('SELECT COUNT(*) n FROM doctors')}</div></div></div>
       <p><a class="btn" href="/patients/new" data-testid="quick-new-patient">Register patient</a> <a class="btn" href="/appointments/new">Book appointment</a></p>
       <div class="card"><h2 style="font-size:16px;margin:0 0 8px">Next appointments</h2><ul id="next-appointments" class="muted"><li>Loading…</li></ul></div>
       <script>
         fetch('/api/appointments').then((r) => r.json()).then((rows) => {
           document.getElementById('next-appointments').innerHTML = rows.slice(0, 3)
             .map((a) => '<li>' + a.date + ' ' + a.time + ' · ' + a.patient_name + ' with ' + a.doctor_name + '</li>').join('') || '<li>None</li>';
         });
       </script>`,
      u,
    );
  });

  app.get<{ Querystring: { q?: string; flash?: string } }>('/patients', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const q = (req.query.q ?? '').trim();
    const rows = db
      .prepare(
        'SELECT * FROM patients WHERE full_name LIKE ? OR code LIKE ? OR phone LIKE ? ORDER BY id DESC',
      )
      .all(`%${q}%`, `%${q}%`, `%${q}%`) as Patient[];
    return page(
      reply,
      'Patients',
      `<h1>Patients</h1><div class="card">
      <form class="toolbar" method="get" action="/patients"><input name="q" value="${esc(q)}" placeholder="Search by name, code or phone" aria-label="Search patients" data-testid="patient-search">
      <button type="submit" class="secondary">Search</button><a class="btn" href="/patients/new" style="margin-left:auto">New patient</a></form>
      <table data-testid="patients-table"><thead><tr><th>Code</th><th>Name</th><th>Date of birth</th><th>Phone</th><th>Insurance</th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td>${esc(p.code)}</td><td><a href="/patients/${p.id}">${esc(p.full_name)}</a></td><td>${esc(p.dob)}</td><td>${esc(p.phone)}</td><td>${esc(p.insurance ?? '—')}</td></tr>`).join('')}
      </tbody></table>${rows.length === 0 ? '<p class="muted" data-testid="no-patients">No patients found.</p>' : ''}</div>`,
      u,
      req.query.flash,
    );
  });

  const patientForm = (
    b: Record<string, string | undefined> = {},
    error?: string,
  ) => `<h1>Register a new patient</h1><div class="card">
    ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
    <form method="post" action="/patients">
      <label for="full_name">Full name</label><input id="full_name" name="full_name" value="${esc(b.full_name)}" data-testid="patient-name">
      <div class="row"><div><label for="dob">Date of birth</label><input id="dob" name="dob" type="date" value="${esc(b.dob)}"></div>
      <div><label for="phone">Phone</label><input id="phone" name="phone" value="${esc(b.phone)}" placeholder="+1-555-000-0000" data-testid="patient-phone"></div></div>
      <div class="row"><div><label for="pemail">Email</label><input id="pemail" name="email" value="${esc(b.email)}"></div>
      <div><label for="insurance">Insurance provider</label><input id="insurance" name="insurance" value="${esc(b.insurance)}" data-testid="patient-insurance"></div></div>
      <p><button type="submit" data-testid="save-patient">Save patient</button> <a href="/patients">Cancel</a></p>
    </form></div>`;
  app.get('/patients/new', async (req, reply) => {
    const u = requireUser(req, reply);
    if (u) return page(reply, 'New patient', patientForm(), u);
  });
  app.post<{ Body: Record<string, string> }>('/patients', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const error = validatePatient(req.body);
    if (error) return page(reply.code(422), 'New patient', patientForm(req.body, error), u);
    const p = createPatient(req.body);
    return reply.redirect(`/patients/${p.id}?flash=${encodeURIComponent(`Patient ${p.code} registered`)}`);
  });
  app.get<{ Params: { id: string }; Querystring: { flash?: string } }>(
    '/patients/:id',
    async (req, reply) => {
      const u = requireUser(req, reply);
      if (!u) return;
      const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id) as Patient | undefined;
      if (!p) return page(reply.code(404), 'Not found', '<h1>Patient not found</h1>', u);
      const appts = db
        .prepare(
          'SELECT a.*, d.name doctor FROM appointments a JOIN doctors d ON d.id = a.doctor_id WHERE patient_id = ? ORDER BY date, time',
        )
        .all(p.id) as { date: string; time: string; doctor: string; status: string }[];
      return page(
        reply,
        p.full_name,
        `<h1 data-testid="patient-title">${esc(p.full_name)}</h1><div class="card">
      <p><strong>Patient code:</strong> <span id="patient-code">${esc(p.code)}</span></p><p><strong>Date of birth:</strong> ${esc(p.dob)}</p>
      <p><strong>Phone:</strong> ${esc(p.phone)}</p><p><strong>Email:</strong> ${esc(p.email ?? '—')}</p><p><strong>Insurance:</strong> <span data-testid="patient-insurance-value">${esc(p.insurance ?? 'None')}</span></p>
      <p><a class="btn" href="/appointments/new?patient=${p.id}">Book appointment</a></p></div>
      <div class="card"><h2 style="font-size:16px;margin:0 0 8px">Appointments</h2>${appts.length ? `<ul>${appts.map((a) => `<li>${esc(a.date)} ${esc(a.time)} with ${esc(a.doctor)} (${esc(a.status)})</li>`).join('')}</ul>` : '<p class="muted">No appointments yet.</p>'}</div>`,
        u,
        req.query.flash,
      );
    },
  );

  app.get<{ Querystring: { flash?: string } }>('/appointments', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const rows = db
      .prepare(
        'SELECT a.id, a.date, a.time, a.reason, a.status, p.full_name patient, p.code, d.name doctor FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id ORDER BY a.date, a.time',
      )
      .all() as {
      id: number;
      date: string;
      time: string;
      reason: string;
      status: string;
      patient: string;
      code: string;
      doctor: string;
    }[];
    return page(
      reply,
      'Appointments',
      `<h1>Appointments</h1><div class="card"><div class="toolbar"><a class="btn" href="/appointments/new" data-testid="new-appointment">Book appointment</a></div>
      <table id="appointments-table"><thead><tr><th>Date</th><th>Time</th><th>Patient</th><th>Doctor</th><th>Reason</th><th>Status</th></tr></thead><tbody>
      ${rows.map((a) => `<tr data-testid="appointment-row"><td>${esc(a.date)}</td><td>${esc(a.time)}</td><td>${esc(a.patient)} (${esc(a.code)})</td><td>${esc(a.doctor)}</td><td>${esc(a.reason)}</td><td>${esc(a.status)}</td></tr>`).join('')}
      </tbody></table></div>`,
      u,
      req.query.flash,
    );
  });

  const appointmentForm = (b: Record<string, string | undefined> = {}, error?: string) => {
    const patients = db
      .prepare('SELECT id, code, full_name FROM patients ORDER BY full_name')
      .all() as Patient[];
    return `<h1>Book an appointment</h1><div class="card">${error ? `<div class="error" role="alert" data-testid="booking-error">${esc(error)}</div>` : ''}
    <form method="post" action="/appointments">
      <label for="patient">Patient</label><select id="patient" name="patient_id" data-testid="appointment-patient"><option value="">Select a patient…</option>
      ${patients.map((p) => `<option value="${p.id}" ${String(p.id) === b.patient_id ? 'selected' : ''}>${esc(p.full_name)} (${esc(p.code)})</option>`).join('')}</select>
      <label for="doctor">Doctor</label><select id="doctor" name="doctor_id"><option value="">Select a doctor…</option>
      ${doctors()
        .map(
          (d) =>
            `<option value="${d.id}" ${String(d.id) === b.doctor_id ? 'selected' : ''}>${esc(d.name)} · ${esc(d.specialty)}</option>`,
        )
        .join('')}</select>
      <div class="row"><div><label for="date">Date</label><input id="date" name="date" type="date" value="${esc(b.date)}" data-testid="appointment-date"></div>
      <div><label for="time">Time</label><select id="time" name="time">${['09:00', '09:30', '10:00', '10:30', '11:00', '14:00', '14:30', '15:00'].map((t) => `<option ${t === b.time ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
      <label for="reason">Reason for visit</label><textarea id="reason" name="reason" rows="2">${esc(b.reason)}</textarea>
      <p><button type="submit" data-testid="book-appointment">Book appointment</button></p></form></div>`;
  };
  const validateAppointment = (b: Record<string, string>): string | undefined => {
    if (!b.patient_id) return 'Please select a patient';
    if (!b.doctor_id) return 'Please select a doctor';
    if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return 'Please choose a date';
    if (!b.time) return 'Please choose a time';
    if (!TIME_SLOTS.includes(b.time)) return 'Please choose one of the available time slots';
    if (!/^\d+$/.test(b.patient_id) || !db.prepare('SELECT 1 FROM patients WHERE id = ?').get(b.patient_id))
      return 'Unknown patient';
    if (!/^\d+$/.test(b.doctor_id) || !db.prepare('SELECT 1 FROM doctors WHERE id = ?').get(b.doctor_id))
      return 'Unknown doctor';
    const clash = db
      .prepare(
        "SELECT 1 FROM appointments WHERE doctor_id = ? AND date = ? AND time = ? AND status = 'booked'",
      )
      .get(b.doctor_id, b.date, b.time);
    if (clash) return 'This doctor is already booked at that time';
    return undefined;
  };
  const createAppointment = (b: Record<string, string | undefined>) =>
    db
      .prepare(
        'INSERT INTO appointments (patient_id, doctor_id, date, time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(b.patient_id, b.doctor_id, b.date, b.time, b.reason ?? '', new Date().toISOString())
      .lastInsertRowid;

  app.get<{ Querystring: { patient?: string } }>('/appointments/new', async (req, reply) => {
    const u = requireUser(req, reply);
    if (u) return page(reply, 'Book appointment', appointmentForm({ patient_id: req.query.patient }), u);
  });
  app.post<{ Body: Record<string, string> }>('/appointments', async (req, reply) => {
    const u = requireUser(req, reply);
    if (!u) return;
    const error = validateAppointment(req.body);
    if (error) return page(reply.code(422), 'Book appointment', appointmentForm(req.body, error), u);
    createAppointment(req.body);
    return reply.redirect(`/appointments?flash=${encodeURIComponent('Appointment booked')}`);
  });

  // ─── REST API ───────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, app: 'CareClinic' }));
  app.get('/api/openapi.json', async () => CLINIC_OPENAPI);
  app.post<{ Body: { email?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const t = login(req.body?.email ?? '', req.body?.password ?? '');
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
    // PLANTED BUG CC-API-02 (see demo/manifests/planted_bugs.json): listing appointments skips the auth check.
    if (path === '/api/appointments' && req.method === 'GET') return;
    const u = apiUser(req);
    if (!u) return reply.code(401).send({ error: 'unauthorized', message: 'Login required' });
    (req as FastifyRequest & { user?: User }).user = u;
  });
  app.get('/api/me', async (req) => (req as FastifyRequest & { user: User }).user);
  // PLANTED BUG CC-API-01: the fee is serialised as a string, violating the documented schema (number).
  app.get('/api/doctors', async () => doctors().map((d) => ({ ...d, fee: d.fee.toFixed(2) })));
  app.get<{ Querystring: { q?: string } }>('/api/patients', async (req) => {
    const q = `%${(req.query.q ?? '').trim()}%`;
    return db.prepare('SELECT * FROM patients WHERE full_name LIKE ? OR code LIKE ? ORDER BY id').all(q, q);
  });
  app.get<{ Params: { id: string } }>('/api/patients/:id', async (req, reply) => {
    const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(req.params.id);
    return p ?? reply.code(404).send({ error: 'not_found', message: 'Patient not found' });
  });
  app.post<{ Body: Record<string, unknown> }>('/api/patients', async (req, reply) => {
    const error = validatePatient(req.body ?? {});
    if (error) return reply.code(422).send({ error: 'validation_error', message: error });
    return reply.code(201).send(createPatient(req.body as Record<string, string>));
  });
  app.delete<{ Params: { id: string } }>('/api/patients/:id', async (req, reply) => {
    const u = (req as FastifyRequest & { user: User }).user;
    if (u.role !== 'admin')
      return reply.code(403).send({ error: 'forbidden', message: 'Only admins can delete patients' });
    // PLANTED BUG CC-API-03: deleting an unknown patient returns 204 instead of the documented 404.
    db.transaction(() => {
      db.prepare('DELETE FROM appointments WHERE patient_id = ?').run(req.params.id);
      db.prepare('DELETE FROM patients WHERE id = ?').run(req.params.id);
    })();
    return reply.code(204).send();
  });
  app.get('/api/appointments', async () =>
    db
      .prepare(
        'SELECT a.*, p.full_name patient_name, d.name doctor_name FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN doctors d ON d.id = a.doctor_id ORDER BY date, time',
      )
      .all(),
  );
  app.post<{ Body: Record<string, string | number> }>('/api/appointments', async (req, reply) => {
    const b = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
    const error = validateAppointment(b);
    if (error)
      return reply
        .code(error.includes('already booked') ? 409 : 422)
        .send({ error: 'validation_error', message: error });
    const id = createAppointment(b);
    return reply.code(201).send(db.prepare('SELECT * FROM appointments WHERE id = ?').get(id));
  });
  // Resets the demo data set (used by tests and the StepForge demo workspace). Local demo only.
  app.post('/api/reset', async () => {
    seed(db);
    return { ok: true };
  });

  app.addHook('onClose', async () => db.close());
  return app;
}
