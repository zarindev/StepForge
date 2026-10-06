# Email testing

StepForge tests flows that send email (sign-up verification, one-time login codes, password resets, receipts)
by reading the email the application really sent, then extracting the code or link and continuing the test.

## Two kinds of inbox

| | Mailpit (local) | IMAP |
|---|---|---|
| What | A free, MIT-licensed SMTP server that catches every email sent to it. Nothing is delivered to real people. | Any real mailbox: Gmail, Outlook, Fastmail, a company server. |
| When | The application under test runs locally or in a test environment where you control its SMTP settings. | The application sends real email (staging, production-like environments). |
| Setup | Point the application's SMTP at `127.0.0.1:1025` (no auth, no TLS). | Host, port (993), user, password (Gmail: an *app password*). |

### Local Mailpit

`setup` downloads Mailpit (pinned version, ~10 MB, from its GitHub releases) into `data/bin/`. You can also install
it from **Settings → Email** or with `npm run mailpit:install`. In Settings you can start and stop it, open the
inbox, and choose *Start with StepForge*. It listens on `127.0.0.1` only:

- SMTP: `127.0.0.1:1025` (`STEPFORGE_MAILPIT_SMTP_PORT`)
- Web UI and API: `http://127.0.0.1:8025` (`STEPFORGE_MAILPIT_PORT`)

If something already answers on that port (for example a Mailpit you started yourself), StepForge uses it.
Messages are stored in `data/mailpit/` (the newest 2000 are kept).

### Inboxes per application

Application → **Inboxes**. Add a Mailpit inbox (leave the URL empty to use StepForge's own) or an IMAP inbox, and
use **Test** before saving. IMAP passwords are encrypted (AES-256-GCM) and never sent back to the browser, logged
or exported. **Open** browses an inbox: message list, HTML preview (in a sandboxed frame that cannot run scripts),
text and links. Mailpit inboxes can be cleared.

A step that names no inbox uses the application's first inbox, or the local Mailpit when the application has
none. Steps refer to inboxes by **name**.

### Gmail

1. Turn on 2-Step Verification for the Google account, then create an **app password**
   (Google Account → Security → App passwords). Use it as the IMAP password.
2. IMAP host `imap.gmail.com`, port `993`, TLS on, user = the full address.
3. Sign up with **plus-addressing** so every run uses a fresh address that still lands in the same inbox:
   `you+{{run.id}}@gmail.com`. Store it with `util.setVariable` and use `{{vars.email}}` in the form and in
   `waitForEmail`.

Use a dedicated test account, not a personal one.

## A sign-up scenario

```
util.setVariable        email = qa+{{run.id}}@example.test
ui.navigate             /signup
ui.fill                 Email ← {{vars.email}} … (name, password)
ui.click                "Create account"
email.waitForEmail      to {{vars.email}}, subject "Verify", wait up to 20 s
email.assertEmail       has a link containing "/verify"
email.extractFromEmail  otp → captureAs otp
ui.fill                 "Verification code" ← {{vars.otp}}
ui.click                "Verify email"
ui.assert               flash says "Email verified"
```

The run result shows the received email (HTML, text, links) on the `waitForEmail` step, and the email is saved
as evidence (`emails/` in the run's artifacts). The CareClinic demo has this flow at `/signup` (it sends to
Mailpit on `127.0.0.1:1025`; set `CLINIC_SMTP_PORT` to change it).

## Troubleshooting

- **"Cannot reach Mailpit"** — start it in Settings → Email, or check another program is not using port 8025/1025.
- **The email never arrives** — the app must send to the SMTP address shown in Settings. Emails received *before*
  the test started are ignored by default (`since: any` turns that off).
- **IMAP login failed** — Gmail and Outlook need an app password; check the user is the full email address.
- **"Could not find a one-time code"** — the email has no 4–8 digit code near a word like "code"/"OTP", or it has
  several unlabelled numbers. Use `kind: regex` with a pattern such as `code:\s*(\w+)`.
