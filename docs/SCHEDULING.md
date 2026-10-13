# Schedules and notifications

_By Md Zarin Tasnim · part of the StepForge documentation_

## Schedules

**Schedules** (left rail) runs tests automatically while StepForge is open. A schedule has:

- an application and environment, and which tests to run (all, a tag or a module) — or a **campaign**, which brings
  its own environments, browsers and screen sizes (one summary is sent when the whole campaign has finished; see
  [CAMPAIGNS.md](CAMPAIGNS.md));
- **when**: a preset (every night at 02:00, weekdays at 06:00, every hour, every 15 minutes, Mondays at 07:00) or
  a cron expression. The editor shows the next five run times, in the computer's time zone, and rejects invalid
  expressions;
- run options (browser, retries);
- the notification channels that receive the summary;
- an on/off switch.

Each row shows the next and last run; **Run now** starts it immediately (also when it is switched off). Expand a
row for its history: every run with its result and, per channel, whether the summary was sent, skipped or failed.
Scheduled runs are ordinary runs (trigger **schedule**) with evidence, diagnoses, bugs and analytics. Home lists
the next enabled schedules.

### Cron expressions

Five fields, `minute hour day-of-month month day-of-week`, or six with seconds first:

| Expression | Runs |
|---|---|
| `0 2 * * *` | Every day at 02:00 |
| `30 1 * * 1-5` | Weekdays at 01:30 |
| `*/10 8-18 * * *` | Every 10 minutes from 08:00 to 18:59 |
| `0 7 1 * *` | The 1st of every month at 07:00 |

Schedules use [croner](https://github.com/Hexagon/croner), which also gives the next-run preview. If a run is
still going when the next time comes, that time is skipped.

### When StepForge is closed

The in-app scheduler runs only while StepForge is open; times missed while it was closed are **not** made up when
it starts again. For unattended runs, start the [CLI](CLI.md) from cron, Windows Task Scheduler or CI instead.

## Notifications

**Settings → Notifications** holds the channels. Each sends **after every run** or **only when tests fail**.

The summary contains the application and environment, passed/total with failed, broken, flaky and skipped
counts, the schedule name, pass rate and duration, the **quality gate** verdict with its failing rules, the
**failed tests with their diagnosis** (or first error line; up to 10, then "… and N more"), and a link to the run
in the dashboard. Every message ends with "Sent by StepForge — by Md Zarin Tasnim".

### Telegram

1. In Telegram, talk to **@BotFather**, send `/newbot` and copy the token.
2. Add the bot to your group (or start a chat with it).
3. Find the chat ID, e.g. by sending a message in the group and opening
   `https://api.telegram.org/bot<token>/getUpdates`; group IDs start with `-100`.
4. Add a Telegram channel with the token and chat ID, then **Send test**.

The token is stored encrypted and never shown again (leave it empty when editing to keep it). Errors never include
it.

### Email

Any SMTP server: your mail provider (host, port 587 or 465 with TLS, username, password) or StepForge's local
Mailpit (`127.0.0.1`, the SMTP port from Settings → Email, no login) to try it out. Recipients are separated by
commas. The password is stored encrypted.

### Slack, Mattermost and Rocket.Chat

1. Create an **Incoming Webhook**: Slack → *Apps* → *Incoming WebHooks* (pick the channel); Mattermost or
   Rocket.Chat (both free and self-hostable) → *Integrations* → *Incoming webhook*.
2. Settings → Notifications → **Slack / Mattermost** → paste the URL, choose the app (Slack and Rocket.Chat share a
   format; Mattermost uses its own bold text and links), optionally a **mention on failure** (`<!here>` in Slack,
   `@channel` in Mattermost) → **Send test**.

The message is a coloured attachment (green or red) with the counts, gate, failed tests and diagnosis, and a link to
the run.

### Microsoft Teams

In the Teams channel: **⋯ → Workflows → "Post to a channel when a webhook request is received"**, then paste the URL
it gives you into a **Teams** channel. The summary arrives as an Adaptive Card with an **Open the run** button.
(Microsoft has retired the old "Incoming Webhook" connectors; Workflows replace them.)

### Any other service (webhook)

A **Webhook** channel POSTs JSON to your URL — `{ "event": "run.finished", "summary": { … }, "text": "…" }`, where
`summary` has the application, environment, status, totals, pass rate, duration, failed tests with their diagnosis,
gate and link — with optional extra headers (e.g. `Authorization`). Use it for Discord (with a small relay), n8n,
Home Assistant, or your own service.

Webhook URLs contain a token, so they are stored encrypted like passwords, never shown again, and never included in
error messages.

### Sending from the CLI

`stepforge run … --notify "QA team"` sends the same summary after a CLI run. A finished run's summary can also be
sent again with `POST /api/runs/:id/notify` (`{"channelIds": [...]}`).

## API

| Method | Path | |
|---|---|---|
| GET | `/api/schedules[?applicationId=]` | Schedules with their last run |
| GET | `/api/schedules/upcoming` | Next enabled schedules |
| GET | `/api/schedules/preview?cron=&count=` | Next run times (400 `invalid_cron`) |
| POST | `/api/applications/:id/schedules` | Create |
| PUT / DELETE | `/api/schedules/:id` | Update / delete |
| POST | `/api/schedules/:id/run` | Run now |
| GET | `/api/schedules/:id/runs` | History with notification results |
| GET / POST | `/api/notify-channels` | List / create |
| PUT / DELETE | `/api/notify-channels/:id` | Update / delete |
| POST | `/api/notify-channels/:id/test` | Send a test message |

Live events: `schedule.triggered`, `notifications.sent`.
