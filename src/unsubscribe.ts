/**
 * Unsubscribing, done once and done properly.
 *
 * Three things make a mailing list something people do not hate, and all
 * three live here so no app has to remember them:
 *
 *   1. The link works WITHOUT signing in, from the mail itself — so it carries
 *      a signed token (HMAC-SHA256) naming the person and the list, which the
 *      app verifies. No account lookup by email, nothing to guess.
 *   2. It works in ONE click from the mail client's own button: Gmail and
 *      Yahoo require `List-Unsubscribe` plus `List-Unsubscribe-Post` for bulk
 *      senders (RFC 8058), and a message without them is filed as spam.
 *   3. It does not expire. A link in a six-month-old mail still works; an
 *      expired one is how somebody ends up reporting spam instead.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribeSubject {
  /** Who: the app's own id for the person, never an email address. */
  user: string;
  /** Which list: «due», «digest» … whatever the app calls its kinds of mail. */
  list: string;
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function mac(secret: string, body: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** `<payload>.<mac>`: safe in a URL path or query. */
export function signUnsubscribe(secret: string, subject: UnsubscribeSubject): string {
  if (!secret) throw new Error("mail-kit: unsubscribe needs a secret");
  const body = b64url(Buffer.from(JSON.stringify([subject.user, subject.list])));
  return `${body}.${mac(secret, body)}`;
}

/** The subject the token names, or `null` if it was not made with this secret. */
export function verifyUnsubscribe(secret: string, token: string): UnsubscribeSubject | null {
  if (!secret) return null;
  const [body, given, ...rest] = token.split(".");
  if (!body || !given || rest.length) return null;
  const expected = Buffer.from(mac(secret, body));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const [user, list] = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown[];
    return typeof user === "string" && typeof list === "string" && user && list
      ? { user, list }
      : null;
  } catch {
    return null;
  }
}

/**
 * The two headers that put an "Unsubscribe" button in the mail client itself.
 * `url` must accept a POST with `List-Unsubscribe=One-Click` and act on it
 * without a page, a login or a confirmation.
 */
export function listUnsubscribeHeaders(url: string, mailto?: string): Record<string, string> {
  if (!/^https:\/\//i.test(url)) throw new Error("mail-kit: List-Unsubscribe needs an https URL");
  return {
    "List-Unsubscribe": mailto ? `<${url}>, <mailto:${mailto}>` : `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
