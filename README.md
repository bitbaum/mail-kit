# @bitbaum/mail-kit

The fleet's **one** email layer. One provider (Resend), one env contract, one
call shape, zero runtime dependencies.

Exists because the fleet grew ~12 bespoke email implementations across three
provider styles, and a dead SMTP credential silenced two apps' outbound mail
for months without anyone noticing. Uniformity is the fix.

## Install

```bash
pnpm add @bitbaum/mail-kit
```

## Use

```ts
import { sendMail, isMailConfigured, mailHealth, conventionalFrom } from "@bitbaum/mail-kit";

const result = await sendMail({
  to: "person@example.ch",
  subject: "Your invoice",
  html: "<p>…</p>",
  attachments: [{ filename: "invoice.pdf", content: pdfBuffer, contentType: "application/pdf" }],
});

if (!result.sent) {
  // result.error, result.status?, result.retryable — sendMail NEVER throws.
  logger.error("invoice email failed", result);
}
```

- **`sendMail` never throws.** A thrown email error inside a server action
  reaches nobody and destroys the form; a `{ sent: false }` you must look at
  is deliverable. Callers where delivery matters check `.sent`.
- **`isMailConfigured()`** — gate flows that *depend* on an email arriving
  (password reset, invoices). A placeholder key and a production sandbox
  sender (`@resend.dev`) count as **unconfigured**: both look configured and
  deliver to nobody.
- **`mailHealth()`** — key-validity + domain-status probe for `/api/health`.
  A passing probe does not prove delivery; only a real send does.
- **`options.idempotencyKey`** — pass from crons/queues so a retried job
  cannot double-send (Resend dedupes for 24h).

## One address per app: `hello@<host>`

Every app has one address, on its own host, that a customer can guess:
`hello@<app>.orangecat.ch` on the box, and `hello@murphys-bar.ch` once a site
has its own domain. `appAddress(url)` builds it; `appAddressFromEnv()` reads `MAIL_ADDRESS`
or derives it from `APP_URL` / `NEXT_PUBLIC_SITE_URL` / `AUTH_URL`.

`sendMail` puts that address in **Reply-To** on every message (unless the call
sets its own, or already sends from it). Mail still leaves through the shared
sender until each host can sign its own — but every answer reaches the app.

## Mail to an app

The fleet's mail gateway receives for every app host, checks SPF/DKIM/DMARC,
and POSTs an `InboundMail` to `/api/mail/inbound`, signed with
`MAIL_INBOUND_SECRET` (`x-mail-signature: t=…,v1=hmac`). The app side is one
line:

```ts
// app/api/mail/inbound/route.ts
import { inboundHandler } from "@bitbaum/mail-kit";
export const POST = inboundHandler({ onMail: (mail) => saveAndTriage(mail) });
```

Unsigned, tampered, stale (> 5 min) or oversized deliveries are refused before
your code runs; a thrown `onMail` answers 500 so the gateway retries.

## AI triage

`triageMail(mail, complete, context)` asks a model (any `complete()` — the
ai-forms / ai-kit shape) for `kind`, `urgency`, a one-line `summary`, the
sender's `language` and `needsHuman`. It never throws: no model, or nonsense
back, and the answer comes from plain rules, marked `by: "rules"`. Instructions
inside an email are described, never followed.

## Env contract (the whole of it)

| Var                   | Meaning                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `RESEND_API_KEY`      | required to send (a fleet key: `/opt/fleet/env`)                              |
| `RESEND_FROM`         | sender — `Name <addr>` or bare address (optional if every call passes `from`) |
| `MAIL_ADDRESS`        | the app's own address; optional, derived from the app's URL                   |
| `MAIL_INBOUND_SECRET` | verifies mail from the gateway (a fleet key: `/opt/fleet/env`)                |

## Fleet conventions

- The shared Resend account is on the **free tier**: 1 verified domain,
  **100 emails/day**, 3,000/month. Hitting the daily cap surfaces as
  `{ sent: false, status: 429, retryable: true }`.
- Only `loki.orangecat.ch` is verified, so every app sends as
  `<app>@fleetcrown.orangecat.ch` — `conventionalFrom("My App")` builds it.
- A daily canary on the box sends one real email and alerts Telegram when it
  fails — that, not this package, is what proves delivery keeps working.

## What this is not

- Not a template engine — apps own their HTML.
- Not a queue — `retryable` tells a caller *whether* a retry can help;
  scheduling one is the caller's decision.
- Not for bulk — newsletters go through Listmonk.

---

Part of **[bitbaum](https://bitbaum.orangecat.ch)** — AI-native products on open
infrastructure, built in Zürich. Every package here lists the apps that use it:
**[which apps use mail-kit](https://bitbaum.orangecat.ch/packages/#mail-kit)**.
