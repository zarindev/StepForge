import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomInt } from 'node:crypto';
import nodemailer from 'nodemailer';
import { hash } from './db.ts';
import { esc, layout } from './views.ts';

export type SmtpOptions = { host: string; port: number };

const CODE_TTL_MS = 10 * 60_000;

const signupView = (
  error?: string,
  v: Record<string, string> = {},
) => `<div class="card" style="max-width:420px;margin:40px auto">
<h1>Create your CareClinic account</h1>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/signup">
  <label for="su-name">Full name</label><input id="su-name" name="name" value="${esc(v.name)}" autocomplete="name">
  <label for="su-email">Email</label><input id="su-email" name="email" type="email" value="${esc(v.email)}" data-testid="signup-email" autocomplete="email">
  <label for="su-password">Password</label><input id="su-password" name="password" type="password" autocomplete="new-password">
  <p><button type="submit" data-testid="signup-submit">Create account</button></p>
</form>
<p class="muted">Already registered? <a href="/login">Sign in</a></p></div>`;

const verifyView = (
  email: string,
  error?: string,
) => `<div class="card" style="max-width:420px;margin:40px auto">
<h1>Verify your email</h1>
<p>We sent a 6-digit code to <strong data-testid="verify-email">${esc(email)}</strong>.</p>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/verify">
  <input type="hidden" name="email" value="${esc(email)}">
  <label for="code">Verification code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" data-testid="verify-code">
  <p><button type="submit">Verify email</button></p>
</form></div>`;

/**
 * Sign-up with email verification: the account is created unverified, a 6-digit code (and a link) is mailed
 * through SMTP (Mailpit locally), and only verified accounts can sign in.
 */
export function registerSignup(app: FastifyInstance, db: Database.Database, smtp: SmtpOptions) {
  const mailer = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: false,
    ignoreTLS: true,
  });
  const html = (reply: FastifyReply, title: string, body: string, code = 200) =>
    reply
      .code(code)
      .type('text/html')
      .send(layout(title, body, null));

  const issueCode = async (email: string, name: string, origin: string) => {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare('INSERT OR REPLACE INTO email_codes (email, code, expires_at) VALUES (?, ?, ?)').run(
      email,
      code,
      new Date(Date.now() + CODE_TTL_MS).toISOString(),
    );
    const link = `${origin}/verify?email=${encodeURIComponent(email)}&code=${code}`;
    await mailer.sendMail({
      from: 'CareClinic <no-reply@careclinic.test>',
      to: email,
      subject: 'Verify your CareClinic account',
      text: `Hi ${name},\n\nYour verification code is ${code}. It expires in 10 minutes.\n\nOr open this link: ${link}\n`,
      html: `<p>Hi ${esc(name)},</p><p>Your verification code is <strong>${code}</strong>. It expires in 10 minutes.</p><p><a href="${esc(link)}">Verify my email</a></p>`,
    });
  };

  const verify = (email: string, code: string): string | undefined => {
    const row = db.prepare('SELECT code, expires_at FROM email_codes WHERE email = ?').get(email) as
      { code: string; expires_at: string } | undefined;
    if (!row || row.code !== code.trim()) return 'That code is not correct';
    if (Date.parse(row.expires_at) < Date.now())
      return 'That code has expired. Sign up again to get a new one.';
    db.transaction(() => {
      db.prepare('UPDATE users SET verified = 1 WHERE email = ?').run(email);
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
    })();
    return undefined;
  };

  app.get('/signup', async (_req, reply) => html(reply, 'Sign up', signupView()));

  app.post<{ Body: Record<string, string | undefined> }>('/signup', async (req, reply) => {
    const b = {
      name: (req.body.name ?? '').trim(),
      email: (req.body.email ?? '').trim().toLowerCase(),
      password: req.body.password ?? '',
    };
    const error = !b.name
      ? 'Full name is required'
      : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)
        ? 'Email address is invalid'
        : b.password.length < 8
          ? 'Password must be at least 8 characters'
          : db.prepare('SELECT 1 FROM users WHERE email = ? AND verified = 1').get(b.email)
            ? 'An account with this email already exists'
            : undefined;
    if (error) return html(reply, 'Sign up', signupView(error, b), 422);
    db.prepare('DELETE FROM users WHERE email = ? AND verified = 0').run(b.email);
    db.prepare(
      "INSERT INTO users (email, name, role, password_hash, verified) VALUES (?, ?, 'receptionist', ?, 0)",
    ).run(b.email, b.name, hash(b.password));
    try {
      await issueCode(b.email, b.name, `${req.protocol}://${req.headers.host}`);
    } catch (err) {
      return html(
        reply,
        'Sign up',
        signupView(`We could not send the email: ${(err as Error).message}`, b),
        502,
      );
    }
    return reply.redirect(`/verify?email=${encodeURIComponent(b.email)}`);
  });

  // The emailed link carries the code; without it the page asks for the code.
  app.get<{ Querystring: { email?: string; code?: string } }>('/verify', async (req, reply) => {
    const email = (req.query.email ?? '').toLowerCase();
    if (!req.query.code) return html(reply, 'Verify email', verifyView(email));
    const error = verify(email, req.query.code);
    if (error) return html(reply, 'Verify email', verifyView(email, error), 400);
    return reply.redirect(`/login?verified=1`);
  });
  app.post<{ Body: { email?: string; code?: string } }>('/verify', async (req, reply) => {
    const email = (req.body.email ?? '').toLowerCase();
    const error = verify(email, req.body.code ?? '');
    if (error) return html(reply, 'Verify email', verifyView(email, error), 400);
    return reply.redirect(`/login?verified=1`);
  });
}
