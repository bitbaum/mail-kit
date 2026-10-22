/**
 * Mail TO an app: the contract between the fleet's mail gateway (on the box,
 * receiving for every app host) and each app.
 *
 * The gateway parses the message, checks where it really came from, and POSTs
 * an `InboundMail` as JSON to the app's `/api/mail/inbound`, signed with
 * `MAIL_INBOUND_SECRET` (a fleet key, /opt/fleet/env). The app verifies the
 * signature with `inboundHandler()` and gets a typed message; everything
 * unsigned, stale or replayed is refused before the app's code runs.
 *
 * Signature header: `x-mail-signature: t=<unix seconds>,v1=<hex hmac>`, the
 * HMAC-SHA256 of `${t}.${rawBody}`. The timestamp bounds replay; the
 * message id lets an app refuse the same mail twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const INBOUND_SIGNATURE_HEADER = "x-mail-signature";
/** Where the gateway delivers. Fixed, so no app has to configure it. */
export const INBOUND_PATH = "/api/mail/inbound";
const DEFAULT_TOLERANCE_SECONDS = 300;
/** A body larger than this is refused rather than read (attachments travel as metadata only). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export type AuthVerdict = "pass" | "fail" | "none";

export interface MailParty {
  address: string;
  name?: string;
}

export interface InboundMail {
  /** The gateway's id for this delivery; stable across retries. */
  id: string;
  /** RFC 5322 Message-ID, without angle brackets, when the sender set one. */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  receivedAt: string;
  /** The app address it was sent to, e.g. hello@skif.orangecat.ch. */
  to: string;
  from: MailParty;
  replyTo?: MailParty;
  cc?: MailParty[];
  subject: string;
  /** Plain text: the text part, or the html part reduced to text. */
  text: string;
  html?: string;
  /** Attachments are not forwarded, only described: an app that needs one
   * asks the gateway for it by id. */
  attachments: { filename: string; contentType: string; size: number }[];
  /** What the gateway could verify about the sender. A `fail` is delivered
   * anyway, marked, so the app (and its AI) can treat it as suspect. */
  auth: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
}

export function signInbound(body: string, secret: string, now: number = Date.now()): string {
  const t = Math.floor(now / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export type InboundCheck =
  { ok: true; mail: InboundMail } | { ok: false; status: 400 | 401 | 413; error: string };

/** Verify a delivery and parse it. Never throws. */
export function verifyInbound(
  body: string,
  signature: string | null | undefined,
  secret: string,
  {
    now = Date.now(),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  }: { now?: number; toleranceSeconds?: number } = {},
): InboundCheck {
  if (!secret) return { ok: false, status: 401, error: "MAIL_INBOUND_SECRET is not set" };
  if (Buffer.byteLength(body) > MAX_BODY_BYTES)
    return { ok: false, status: 413, error: "too large" };
  const parts = Object.fromEntries(
    (signature ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]),
  );
  const t = Number(parts["t"]);
  const v1 = parts["v1"] ?? "";
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1))
    return { ok: false, status: 401, error: "missing or malformed signature" };
  if (Math.abs(now / 1000 - t) > toleranceSeconds)
    return { ok: false, status: 401, error: "signature too old" };
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, status: 401, error: "bad signature" };
  let mail: unknown;
  try {
    mail = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: "not JSON" };
  }
  return isInboundMail(mail)
    ? { ok: true, mail }
    : { ok: false, status: 400, error: "not an InboundMail" };
}

function isInboundMail(x: unknown): x is InboundMail {
  const m = x as Partial<InboundMail> | null;
  return (
    !!m &&
    typeof m.id === "string" &&
    typeof m.to === "string" &&
    typeof m.subject === "string" &&
    typeof m.text === "string" &&
    typeof m.receivedAt === "string" &&
    !!m.from &&
    typeof m.from.address === "string" &&
    Array.isArray(m.attachments) &&
    !!m.auth &&
    typeof m.auth.spf === "string"
  );
}

/**
 * The app side, as a fetch-style route handler:
 *
 *   // app/api/mail/inbound/route.ts
 *   export const POST = inboundHandler({ onMail: (mail) => saveAndTriage(mail) });
 *
 * Answers 200 once `onMail` resolves (the gateway stops retrying), 401/400/413
 * for a refused delivery, and 500 when `onMail` throws (the gateway retries).
 */
export function inboundHandler({
  onMail,
  secret,
  env = process.env,
}: {
  onMail: (mail: InboundMail) => Promise<void> | void;
  secret?: string;
  env?: Record<string, string | undefined>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return Response.json({ error: "too large" }, { status: 413 });
    const body = await request.text();
    const check = verifyInbound(
      body,
      request.headers.get(INBOUND_SIGNATURE_HEADER),
      secret ?? env["MAIL_INBOUND_SECRET"] ?? "",
    );
    if (!check.ok) return Response.json({ error: check.error }, { status: check.status });
    try {
      await onMail(check.mail);
    } catch (error) {
      console.error(
        "[mail-kit] inbound handler failed:",
        error instanceof Error ? error.message : error,
      );
      return Response.json({ error: "not stored, retry" }, { status: 500 });
    }
    return Response.json({ ok: true });
  };
}
