/**
 * @bitbaum/mail-kit — the fleet's one email layer.
 *
 * One provider (Resend), one env contract, one call shape, across every app.
 * Exists because the fleet grew ~12 bespoke email implementations across three
 * provider styles, and a dead SMTP credential silenced two apps' outbound mail
 * for months without anyone noticing (2026-09-05). Uniformity is the fix:
 * every app sends through this module, and one canary watches the account.
 *
 * Design rules:
 * - Zero runtime dependencies: the Resend HTTP API is one POST; an SDK buys
 *   nothing and costs every consumer a dependency.
 * - `sendMail` NEVER throws. It returns an honest result. A thrown email
 *   error inside a server action reaches nobody and destroys the form
 *   ([refusal-reaches-nobody]); a `{ sent: false }` the caller must look at
 *   is deliverable.
 * - "Configured-looking but dead" states count as unconfigured: a sandbox
 *   sender (`@resend.dev`) delivers only to the account owner, and a
 *   placeholder key delivers to nobody. Both shipped to production once.
 *
 * Env contract (the whole of it):
 * - RESEND_API_KEY  — required for sending.
 * - RESEND_FROM     — sender, either `Name <addr>` or a bare address.
 *                     Optional when the app passes `from` per call.
 *
 * Fleet convention: only `loki.orangecat.ch` is verified in the shared
 * Resend account (free tier = 1 domain, 100 emails/day, 3000/month), so every
 * app sends as `<app>@fleetcrown.orangecat.ch` — see `conventionalFrom()`.
 */

const RESEND_API_URL = "https://api.resend.com";

/** The shared account's single verified sender domain. */
export const FLEET_SENDER_DOMAIN = "loki.orangecat.ch";

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
  attachments?: MailAttachment[];
}

export interface SendOptions {
  /** Abort the HTTP call after this many ms. Default 15000. */
  timeoutMs?: number;
  /**
   * Resend deduplicates sends sharing an idempotency key for 24h — pass one
   * from retry-prone paths (crons, queues) so a retried job can't double-send.
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
      /** HTTP status when the API answered; absent on network/config errors. */
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
 * The configured sender, or undefined. Per-call `from` beats RESEND_FROM.
 */
export function fromAddress(env?: Record<string, string | undefined>): string | undefined {
  const value = readEnv(env)["RESEND_FROM"]?.trim();
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
export function isMailConfigured(env?: Record<string, string | undefined>): boolean {
  const e = readEnv(env);
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

  if (!isMailConfigured(env)) {
    return {
      sent: false,
      error: apiKey(env)
        ? "Mail is misconfigured: placeholder key or sandbox sender in production"
        : "RESEND_API_KEY is not set",
      retryable: false,
    };
  }

  const from = message.from ?? fromAddress(env);
  if (!from) {
    return { sent: false, error: "No sender: set RESEND_FROM or pass `from`", retryable: false };
  }
  if (!message.html && !message.text) {
    return { sent: false, error: "Message needs html and/or text", retryable: false };
  }

  const body = {
    from,
    to: toArray(message.to),
    subject: message.subject,
    ...(message.html ? { html: message.html } : {}),
    ...(message.text ? { text: message.text } : {}),
    ...(message.cc ? { cc: toArray(message.cc) } : {}),
    ...(message.bcc ? { bcc: toArray(message.bcc) } : {}),
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
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
  if (!isMailConfigured(env)) {
    return { ok: false, error: "not configured" };
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
