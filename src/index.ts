/**
 * @bitbaum/mail-kit — the fleet's one email layer.
 *
 * One call shape across every app, over Resend (the default) or the app's own
 * mail server (SMTP, chosen explicitly — see smtp.ts).
 * Exists because the fleet grew ~12 bespoke email implementations across three
 * provider styles, and a dead SMTP credential silenced two apps' outbound mail
 * for months without anyone noticing (2026-09-05). Uniformity is the fix:
 * every app sends through this module, and one canary watches the account.
 *
 * Design rules:
 * - Zero runtime dependencies: the Resend HTTP API is one POST; an SDK buys
 *   nothing and costs every consumer a dependency. SMTP is the exception
 *   that proves it: nodemailer is an optional peer, loaded only when an app
 *   chooses SMTP.
 * - `sendMail` NEVER throws. It returns an honest result. A thrown email
 *   error inside a server action reaches nobody and destroys the form
 *   ([refusal-reaches-nobody]); a `{ sent: false }` the caller must look at
 *   is deliverable.
 * - "Configured-looking but dead" states count as unconfigured: a sandbox
 *   sender (`@resend.dev`) delivers only to the account owner, and a
 *   placeholder key delivers to nobody. Both shipped to production once.
 *
 * Env contract (the whole of it):
 * - MAIL_TRANSPORT      — `resend` (default) or `smtp`.
 * - RESEND_API_KEY      — required for sending through Resend.
 * - RESEND_FROM         — Resend sender, either `Name <addr>` or a bare address.
 *                         Optional when the app passes `from` per call.
 * - SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true on 465), SMTP_USER,
 *   SMTP_PASS, SMTP_FROM — the app's own mail server, when MAIL_TRANSPORT=smtp.
 * - MAIL_ADDRESS        — the app's own address, `hello@<host>` (address.ts).
 *                         Optional: derived from APP_URL & co. when unset.
 *                         Every message carries it as Reply-To.
 * - MAIL_INBOUND_SECRET — verifies mail the gateway delivers (inbound.ts).
 *
 * Fleet convention: only `fleetcrown.orangecat.ch` is verified in the shared
 * Resend account (free tier = 1 domain, 100 emails/day, 3000/month), so every
 * app sends as `<app>@fleetcrown.orangecat.ch` — see `conventionalFrom()`.
 */

import { appAddressFromEnv } from "./address.js";
import {
  smtpConfigFrom,
  smtpConfigProblem,
  smtpFailure,
  smtpTransporter,
  SmtpUnavailable,
  type SmtpConfig,
} from "./smtp.js";

export type MailTransport = "resend" | "smtp";

const RESEND_API_URL = "https://api.resend.com";

/** The shared account's single verified sender domain. */
// The Resend-verified sending domain. It still carries the old product name:
// the product became Loki on 2026-09-14, but a sending domain is DNS + DKIM,
// not a string — until loki.orangecat.ch is verified in Resend, mail from any
// other domain is rejected. Do not "fix" this to match the product name.
export const FLEET_SENDER_DOMAIN = "fleetcrown.orangecat.ch";

/**
 * Resend's sandbox domain: mail "sends" fine but reaches ONLY the account
 * owner's own inbox — in production that is a silent lockout for every user.
 */
const SANDBOX_SENDER_DOMAIN = "resend.dev";

export interface MailAttachment {
  filename: string;
  /** Raw bytes or an already-base64-encoded string. */
  content: Uint8Array | string;
  contentType?: string;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  /** At least one of html / text is required. */
  html?: string;
  text?: string;
  /** Overrides RESEND_FROM for this message. `Name <addr>` or bare address. */
  from?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  /**
   * Extra headers. For bulk mail, `listUnsubscribeHeaders()` — a message to
   * many people without them is filed as spam by Gmail and Yahoo.
   */
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
}

export interface SendOptions {
  /** Abort the HTTP call (or each SMTP connect/greeting/socket wait) after this many ms. Default 15000. */
  timeoutMs?: number;
  /** Which way mail leaves. Default: MAIL_TRANSPORT, else `resend`. */
  transport?: MailTransport;
  /**
   * The app's mail server, for apps whose settings live under their own
   * names (EMAIL_HOST …). Default: SMTP_HOST / SMTP_PORT / SMTP_SECURE /
   * SMTP_USER / SMTP_PASS.
   */
  smtp?: SmtpConfig;
  /**
   * Resend deduplicates sends sharing an idempotency key for 24h — pass one
   * from retry-prone paths (crons, queues) so a retried job can't double-send.
   * SMTP has no such thing: over SMTP the key is ignored.
   */
  idempotencyKey?: string;
  /** Environment to read config from. Default `process.env`. */
  env?: Record<string, string | undefined>;
}

export type SendResult =
  | { sent: true; id: string }
  | {
      sent: false;
      error: string;
      /** HTTP status when Resend answered; absent on network/config errors and over SMTP. */
      status?: number;
      /**
       * True for failures worth retrying later (429 quota/rate limit, 5xx,
       * network). False for failures a retry cannot fix (bad request, unknown
       * sender domain, unconfigured).
       */
      retryable: boolean;
    };

function readEnv(env?: Record<string, string | undefined>) {
  return env ?? process.env;
}

/**
 * The transport in use: the option, else MAIL_TRANSPORT, else Resend. An
 * unknown value is not silently Resend — it is reported by `sendMail`.
 */
export function mailTransport(
  env?: Record<string, string | undefined>,
  override?: MailTransport,
): MailTransport | undefined {
  const value = (override ?? readEnv(env)["MAIL_TRANSPORT"] ?? "").trim().toLowerCase();
  if (value === "" || value === "resend") return "resend";
  if (value === "smtp") return "smtp";
  return undefined;
}

function apiKey(env?: Record<string, string | undefined>): string {
  return readEnv(env)["RESEND_API_KEY"] ?? "";
}

/** Extract the bare address out of `Name <addr>` (or return the input). */
function bareAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim().toLowerCase();
}

/** True when this sender can only reach the provider account owner. */
export function usesSandboxSender(from: string): boolean {
  return bareAddress(from).endsWith(`@${SANDBOX_SENDER_DOMAIN}`);
}

/**
 * The configured sender, or undefined. Per-call `from` beats this. Resend
 * reads RESEND_FROM; SMTP reads SMTP_FROM (the fleet's shared Resend domain
 * is not the app's mail server's to send as).
 */
export function fromAddress(
  env?: Record<string, string | undefined>,
  transport: MailTransport = "resend",
): string | undefined {
  const value = readEnv(env)[transport === "smtp" ? "SMTP_FROM" : "RESEND_FROM"]?.trim();
  return value ? value : undefined;
}

/**
 * Build the fleet-conventional sender for an app:
 * `conventionalFrom("Evig")` → `Evig <evig@fleetcrown.orangecat.ch>`.
 * Use as the fallback when RESEND_FROM is unset.
 */
export function conventionalFrom(appName: string): string {
  const slug = appName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${appName} <${slug}@${FLEET_SENDER_DOMAIN}>`;
}

/**
 * Whether mail can actually go out — not merely whether env vars exist.
 * A placeholder key and (in production) a sandbox sender both count as
 * UNCONFIGURED: they look configured, return no transport error, and deliver
 * to nobody. Flows that depend on delivery (password reset, invoices) should
 * check this and fail loudly instead of promising an email that never comes.
 */
export function isMailConfigured(
  env?: Record<string, string | undefined>,
  options: Pick<SendOptions, "transport" | "smtp"> = {},
): boolean {
  const e = readEnv(env);
  const transport = mailTransport(e, options.transport);
  if (!transport) return false;
  if (transport === "smtp") return !smtpConfigProblem(smtpConfigFrom(e, options.smtp));
  const key = apiKey(e);
  if (!key || key.startsWith("re_placeholder") || key === "undefined") return false;
  const from = fromAddress(e);
  if (e["NODE_ENV"] === "production" && from && usesSandboxSender(from)) return false;
  return true;
}

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function encodeAttachment(a: MailAttachment): {
  filename: string;
  content: string;
  content_type?: string;
} {
  const content =
    typeof a.content === "string"
      ? a.content
      : // Buffer extends Uint8Array, so this covers both.
        Buffer.from(a.content).toString("base64");
  return {
    filename: a.filename,
    content,
    ...(a.contentType ? { content_type: a.contentType } : {}),
  };
}

/**
 * Send one email. Never throws — inspect `result.sent`.
 *
 * Free-tier note: the shared account allows 100 emails/day. Hitting the cap
 * surfaces here as `{ sent: false, status: 429, retryable: true }` — a cron
 * that logs its SendResults makes quota exhaustion visible instead of silent.
 */
export async function sendMail(
  message: MailMessage,
  options: SendOptions = {},
): Promise<SendResult> {
  const env = readEnv(options.env);
  const transport = mailTransport(env, options.transport);
  if (!transport) {
    return {
      sent: false,
      error: `MAIL_TRANSPORT must be "resend" or "smtp", not "${env["MAIL_TRANSPORT"]}"`,
      retryable: false,
    };
  }

  if (transport === "smtp") {
    const problem = smtpConfigProblem(smtpConfigFrom(env, options.smtp));
    if (problem) return { sent: false, error: problem, retryable: false };
  } else if (!isMailConfigured(env)) {
    return {
      sent: false,
      error: apiKey(env)
        ? "Mail is misconfigured: placeholder key or sandbox sender in production"
        : "RESEND_API_KEY is not set",
      retryable: false,
    };
  }

  const from = message.from ?? fromAddress(env, transport);
  if (!from) {
    return {
      sent: false,
      error: `No sender: set ${transport === "smtp" ? "SMTP_FROM" : "RESEND_FROM"} or pass \`from\``,
      retryable: false,
    };
  }
  if (!message.html && !message.text) {
    return { sent: false, error: "Message needs html and/or text", retryable: false };
  }

  // Answers go to the app's own address (address.ts) unless the caller set
  // one, or the message already comes from it.
  const own = appAddressFromEnv(env);
  const replyTo = message.replyTo ?? (own && bareAddress(from) !== own ? own : undefined);

  if (transport === "smtp") {
    return sendOverSmtp(message, from, replyTo, smtpConfigFrom(env, options.smtp)!, options);
  }

  const body = {
    from,
    to: toArray(message.to),
    subject: message.subject,
    ...(message.html ? { html: message.html } : {}),
    ...(message.text ? { text: message.text } : {}),
    ...(message.cc ? { cc: toArray(message.cc) } : {}),
    ...(message.bcc ? { bcc: toArray(message.bcc) } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
    ...(message.attachments?.length
      ? { attachments: message.attachments.map(encodeAttachment) }
      : {}),
  };

  let response: Response;
  try {
    response = await fetch(`${RESEND_API_URL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey(env)}`,
        "Content-Type": "application/json",
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    return {
      sent: false,
      error: `Network error reaching Resend: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      sent: false,
      error: `Resend ${response.status}: ${detail.slice(0, 300)}`,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    };
  }

  const payload = (await response.json().catch(() => ({}))) as { id?: string };
  if (!payload.id) {
    // A 200 without an id has never been observed; treat it as failure rather
    // than fabricate success ([absence-as-evidence]).
    return { sent: false, error: "Resend returned 200 without a message id", retryable: true };
  }
  return { sent: true, id: payload.id };
}

async function sendOverSmtp(
  message: MailMessage,
  from: string,
  replyTo: string | undefined,
  config: SmtpConfig,
  options: SendOptions,
): Promise<SendResult> {
  try {
    const transporter = await smtpTransporter(config, options.timeoutMs ?? 15_000);
    const info = await transporter.sendMail({
      from,
      to: toArray(message.to),
      subject: message.subject,
      ...(message.html ? { html: message.html } : {}),
      ...(message.text ? { text: message.text } : {}),
      ...(message.cc ? { cc: toArray(message.cc) } : {}),
      ...(message.bcc ? { bcc: toArray(message.bcc) } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(message.headers && Object.keys(message.headers).length
        ? { headers: message.headers }
        : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map((a) => ({
              filename: a.filename,
              // A string is already base64 (the MailAttachment contract).
              content: typeof a.content === "string" ? a.content : Buffer.from(a.content),
              ...(typeof a.content === "string" ? { encoding: "base64" } : {}),
              ...(a.contentType ? { contentType: a.contentType } : {}),
            })),
          }
        : {}),
    });
    if (!info.accepted?.length) {
      // The server took the connection but no recipient: nothing went out.
      return { sent: false, error: "SMTP server accepted no recipient", retryable: false };
    }
    if (!info.messageId) {
      return { sent: false, error: "SMTP send returned no message id", retryable: true };
    }
    // NOTE: 250 from a relay is a handoff, not delivery — a relay can accept
    // mail from a sender domain it has not authenticated and drop it later.
    return { sent: true, id: info.messageId };
  } catch (error) {
    if (error instanceof SmtpUnavailable) {
      return { sent: false, error: error.message, retryable: false };
    }
    return { sent: false, ...smtpFailure(error) };
  }
}

export interface MailHealth {
  ok: boolean;
  error?: string;
  /** Domain list when the key is valid — a sender domain not `verified` is a failure waiting to happen. */
  domains?: { name: string; status: string }[];
}

/**
 * Key-validity + domain-status probe for health endpoints and the fleet
 * canary. An authenticated read against /domains: proves the key without
 * sending. NOTE a passing probe does not prove delivery — only a real send
 * does; the fleet's daily canary send covers that.
 */
export async function mailHealth(options: SendOptions = {}): Promise<MailHealth> {
  const env = readEnv(options.env);
  if (!isMailConfigured(env, options)) {
    return { ok: false, error: "not configured" };
  }
  if (mailTransport(env, options.transport) === "smtp") {
    // Connect, TLS and log in, without sending. Proves the credential, not delivery.
    try {
      const transporter = await smtpTransporter(
        smtpConfigFrom(env, options.smtp)!,
        options.timeoutMs ?? 15_000,
      );
      await transporter.verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  let response: Response;
  try {
    response = await fetch(`${RESEND_API_URL}/domains`, {
      headers: { Authorization: `Bearer ${apiKey(env)}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return { ok: false, error: `Resend ${response.status}` };
  }
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { name?: string; status?: string }[];
  };
  return {
    ok: true,
    domains: (payload.data ?? []).map((d) => ({ name: d.name ?? "?", status: d.status ?? "?" })),
  };
}

export { smtpConfigFrom, type SmtpConfig } from "./smtp.js";
export { APP_MAILBOX, appAddress, appAddressFromEnv, hostOf, isAddressFor } from "./address.js";
export {
  INBOUND_PATH,
  INBOUND_SIGNATURE_HEADER,
  inboundHandler,
  signInbound,
  verifyInbound,
  type AuthVerdict,
  type InboundCheck,
  type InboundMail,
  type MailParty,
} from "./inbound.js";
export {
  MAIL_KINDS,
  MAIL_URGENCIES,
  triageByRules,
  triageMail,
  type CompleteFn,
  type MailKind,
  type MailTriage,
  type MailUrgency,
} from "./triage.js";

export {
  escapeHtml,
  renderMail,
  type MailBlock,
  type MailBrand,
  type MailContent,
  type MailFooter,
  type RenderedMail,
} from "./template.js";
export {
  listUnsubscribeHeaders,
  signUnsubscribe,
  verifyUnsubscribe,
  type UnsubscribeSubject,
} from "./unsubscribe.js";
