# Responsible use

_By Md Zarin Tasnim · part of the StepForge documentation_

StepForge is a testing tool. Use it only on software, servers, databases and mailboxes that **you own or are
explicitly authorised to test**.

- **Load tests** generate real traffic. StepForge asks you to confirm, once per application, that you own or are
  authorised to test the system (stored with a timestamp). Load tests against environments marked production also
  require typing the application name. Never load-test third-party services without written permission.
- **Production environments** show a red banner. Destructive database statements against them require typing the
  application name; connections default to read-only with rollback.
- **No circumvention.** StepForge does not solve CAPTCHAs, bypass two-factor authentication or defeat bot protection.
  Use test accounts, test modes or allow-lists provided by the system owner.
- **Personal data.** Recordings, screenshots, videos, traces and emails can contain personal data. They stay on your
  computer; handle them under the rules that apply to you (e.g. GDPR), and use the retention setting and danger zone
  to remove what you no longer need.
- **Email testing** reads the inboxes you configure. Use dedicated test mailboxes and app passwords.
- **Third-party software.** StepForge downloads Playwright's browsers, Mailpit and optionally k6 from their official
  sources; their own licences apply.

StepForge is provided under the [MIT License](LICENSE), "as is", without warranty of any kind. You are responsible for
how you use it.
