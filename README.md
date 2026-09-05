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

## Env contract (the whole of it)

| Var              | Meaning                                             |
| ---------------- | --------------------------------------------------- |
| `RESEND_API_KEY` | required to send                                    |
| `RESEND_FROM`    | sender — `Name <addr>` or bare address (optional if every call passes `from`) |

## Fleet conventions

- The shared Resend account is on the **free tier**: 1 verified domain,
  **100 emails/day**, 3,000/month. Hitting the daily cap surfaces as
  `{ sent: false, status: 429, retryable: true }`.
- Only `fleetcrown.orangecat.ch` is verified, so every app sends as
  `<app>@fleetcrown.orangecat.ch` — `conventionalFrom("My App")` builds it.
- A daily canary on the box sends one real email and alerts Telegram when it
  fails — that, not this package, is what proves delivery keeps working.

## What this is not

- Not a template engine — apps own their HTML.
- Not a queue — `retryable` tells a caller *whether* a retry can help;
  scheduling one is the caller's decision.
- Not for bulk — newsletters go through Listmonk.
