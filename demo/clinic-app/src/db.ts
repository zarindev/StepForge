import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = (pw: string) => createHash('sha256').update(`careclinic:${pw}`).digest('hex');
export const token = () => randomBytes(24).toString('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS doctors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, specialty TEXT NOT NULL, fee REAL NOT NULL);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, dob TEXT NOT NULL, phone TEXT NOT NULL,
  email TEXT, insurance TEXT, created_at TEXT NOT NULL
);
-- PLANTED BUG CC-DB-01 (see demo/manifests/planted_bugs.json): patient_id has no foreign key.
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL, doctor_id INTEGER NOT NULL REFERENCES doctors(id),
  date TEXT NOT NULL, time TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'booked', created_at TEXT NOT NULL
);
`;

const USERS = [
  ['admin@careclinic.test', 'Alex Admin', 'admin', 'Admin123!'],
  ['doctor@careclinic.test', 'Dr. Dana Reyes', 'doctor', 'Doctor123!'],
  ['reception@careclinic.test', 'Riley Reception', 'receptionist', 'Reception123!'],
] as const;
const DOCTORS = [
  ['Dr. Dana Reyes', 'General Practice', 60],
  ['Dr. Omar Haddad', 'Cardiology', 120],
  ['Dr. Mei Lin', 'Pediatrics', 80],
] as const;
const PATIENTS = [
  ['Ana Lopez', '1988-04-12', '+1-555-201-0001', 'ana.lopez@example.test', 'BlueCross'],
  ['Ben Carter', '1975-09-30', '+1-555-201-0002', 'ben.carter@example.test', ''],
  ['Chloe Nguyen', '2012-01-05', '+1-555-201-0003', '', 'Aetna'],
  ['David Okafor', '1960-11-22', '+1-555-201-0004', 'd.okafor@example.test', 'Medicare'],
] as const;

/** Bumped when SCHEMA changes; older demo databases are rebuilt from scratch (it is demo data). */
const SCHEMA_VERSION = 2;

export function openClinicDb(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if ((db.pragma('user_version', { simple: true }) as number) < SCHEMA_VERSION) {
    db.exec(
      'DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS appointments; DROP TABLE IF EXISTS patients;',
    );
    db.exec('DROP TABLE IF EXISTS doctors; DROP TABLE IF EXISTS users;');
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  db.exec(SCHEMA);
  if ((db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n === 0) seed(db);
  return db;
}

/** Restores the deterministic demo data set. */
export function seed(db: Database.Database): void {
  db.transaction(() => {
    db.exec(
      'DELETE FROM sessions; DELETE FROM appointments; DELETE FROM patients; DELETE FROM doctors; DELETE FROM users;',
    );
    const u = db.prepare('INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)');
    for (const [email, name, role, pw] of USERS) u.run(email, name, role, hash(pw));
    const d = db.prepare('INSERT INTO doctors (name, specialty, fee) VALUES (?, ?, ?)');
    for (const row of DOCTORS) d.run(...row);
    const p = db.prepare(
      'INSERT INTO patients (code, full_name, dob, phone, email, insurance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    PATIENTS.forEach((row, i) => p.run(`PAT-${String(1001 + i)}`, ...row, '2026-01-0' + (i + 1)));
    const a = db.prepare(
      'INSERT INTO appointments (patient_id, doctor_id, date, time, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    a.run(1, 1, '2026-11-02', '09:00', 'Annual check-up', '2026-10-01');
    a.run(2, 2, '2026-11-02', '10:30', 'Chest pain follow-up', '2026-10-01');
  })();
}

export const DEMO_CREDENTIALS = USERS.map(([email, name, role, password]) => ({
  email,
  name,
  role,
  password,
}));
