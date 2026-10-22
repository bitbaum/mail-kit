/**
 * One address per app, on the app's own host: `hello@<host>`.
 *
 * Why one, and why `hello`: a customer should be able to guess it. Before
 * this, every app's mail came from `<app>@fleetcrown.orangecat.ch` and nobody
 * could write back to the app at all. Now the address is the site's own name
 * with `hello@` in front of it, whether the site lives at
 * `skif.orangecat.ch` or later at its own domain.
 *
 * Sending from that address needs the host's DKIM key (see the fleet's
 * docs/engineering/email.md); until then mail goes out from the shared sender
 * with `Reply-To: hello@<host>`, so every answer still reaches the app.
 */

/** The local part every app uses. One, so nobody has to guess between
 * support@, info@, contact@ and the rest. */
export const APP_MAILBOX = "hello";

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** `https://Skif.orangecat.ch/x` or `skif.orangecat.ch` → `skif.orangecat.ch`. */
export function hostOf(urlOrHost: string): string {
  const raw = urlOrHost.trim().toLowerCase();
  const host = raw.includes("://") ? new URL(raw).hostname : raw.split("/")[0]!.split(":")[0]!;
  if (!HOST.test(host)) throw new Error(`Not a host name: ${urlOrHost}`);
  return host;
}

/** The app's address: `appAddress("https://skif.orangecat.ch")` → `hello@skif.orangecat.ch`. */
export function appAddress(urlOrHost: string): string {
  return `${APP_MAILBOX}@${hostOf(urlOrHost)}`;
}

/** The app's address from the env contract: `MAIL_ADDRESS`, else derived from
 * the first of `APP_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`,
 * `AUTH_URL`. Undefined when none is set. */
export function appAddressFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const explicit = env["MAIL_ADDRESS"]?.trim();
  if (explicit) return explicit.toLowerCase();
  for (const key of ["APP_URL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SITE_URL", "AUTH_URL"]) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      return appAddress(value);
    } catch {
      continue;
    }
  }
  return undefined;
}

/** True when `address` is some app's address on `host` (any case). */
export function isAddressFor(address: string, host: string): boolean {
  return address.trim().toLowerCase() === appAddress(host);
}
