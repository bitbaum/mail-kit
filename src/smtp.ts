/**
 * The SMTP transport: an app's own mail server, for apps whose mail already
 * leaves that way and must keep doing so when they adopt this package.
 *
 * Resend stays the default. SMTP is chosen explicitly — `MAIL_TRANSPORT=smtp`
 * or `{ transport: "smtp" }` — never guessed from which variables happen to
 * be set, so an app cannot drift onto a different provider by accident.
 *
 * The protocol work is nodemailer's (MIME, encodings, STARTTLS, AUTH, dot-
 * stuffing): it is an optional peer dependency, loaded only when SMTP is
 * chosen, so a Resend-only app installs nothing extra.
 */

export interface SmtpConfig {
  host: string;
  /** Default 587 (submission with STARTTLS). */
  port?: number;
  /** Implicit TLS from the first byte. Default: true on port 465, else false. */
  secure?: boolean;
  /** Both or neither: a relay that allows unauthenticated submission needs none. */
  user?: string;
  pass?: string;
}

/** The part of nodemailer this package uses — consumers need no @types. */
export interface SmtpTransporter {
  sendMail(message: Record<string, unknown>): Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
  }>;
  verify(): Promise<unknown>;
}
type CreateTransport = (options: Record<string, unknown>) => SmtpTransporter;

type Env = Record<string, string | undefined>;

/**
 * SMTP settings from options, else from SMTP_HOST / SMTP_PORT / SMTP_SECURE /
 * SMTP_USER / SMTP_PASS. Undefined when no host is known.
 */
export function smtpConfigFrom(env: Env, override?: SmtpConfig): SmtpConfig | undefined {
  if (override) return override;
  const host = env["SMTP_HOST"]?.trim();
  if (!host) return undefined;
  const port = env["SMTP_PORT"] ? Number(env["SMTP_PORT"]) : undefined;
  const secure =
    env["SMTP_SECURE"] === undefined || env["SMTP_SECURE"] === ""
      ? undefined
      : env["SMTP_SECURE"] === "true";
  return {
    host,
    ...(port !== undefined ? { port } : {}),
    ...(secure !== undefined ? { secure } : {}),
    ...(env["SMTP_USER"] ? { user: env["SMTP_USER"] } : {}),
    ...(env["SMTP_PASS"] ? { pass: env["SMTP_PASS"] } : {}),
  };
}

/** Why this config cannot send, or undefined when it can be tried. */
export function smtpConfigProblem(config: SmtpConfig | undefined): string | undefined {
  if (!config) return "SMTP_HOST is not set";
  if (config.port !== undefined && !(Number.isInteger(config.port) && config.port > 0)) {
    return "SMTP_PORT is not a port number";
  }
  if (Boolean(config.user) !== Boolean(config.pass)) {
    return "SMTP_USER and SMTP_PASS must be set together";
  }
  return undefined;
}

const loader = async (): Promise<CreateTransport> => {
  // Ignored by bundlers on purpose: an app without nodemailer must still
  // build; Node resolves it from the app's node_modules at send time.
  const mod = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ "nodemailer"
  )) as {
    createTransport?: CreateTransport;
    default?: { createTransport?: CreateTransport };
  };
  const create = mod.createTransport ?? mod.default?.createTransport;
  if (!create) throw new Error("nodemailer has no createTransport");
  return create;
};

const cache = new Map<string, SmtpTransporter>();

export async function smtpTransporter(
  config: SmtpConfig,
  timeoutMs: number,
): Promise<SmtpTransporter> {
  const port = config.port ?? 587;
  const key = JSON.stringify([
    config.host,
    port,
    config.secure,
    config.user,
    config.pass,
    timeoutMs,
  ]);
  const known = cache.get(key);
  if (known) return known;
  let create: CreateTransport;
  try {
    create = await loader();
  } catch (error) {
    throw new SmtpUnavailable(
      `SMTP transport needs the nodemailer package installed in the app (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const transporter = create({
    host: config.host,
    port,
    secure: config.secure ?? port === 465,
    ...(config.user ? { auth: { user: config.user, pass: config.pass } } : {}),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  cache.set(key, transporter);
  return transporter;
}

/** nodemailer could not be loaded — a setup error, not a delivery error. */
export class SmtpUnavailable extends Error {}

/**
 * Whether an SMTP failure is worth retrying. 4xx replies are transient by
 * RFC 5321 (greylisting, mailbox busy); 5xx are permanent; a refused login is
 * permanent; a connection that dropped or timed out is not.
 */
export function smtpFailure(error: unknown): { error: string; retryable: boolean } {
  const e = (error ?? {}) as { message?: string; code?: string; responseCode?: number };
  const message = `SMTP ${e.responseCode ?? e.code ?? "error"}: ${(e.message ?? String(error)).slice(0, 300)}`;
  // The reply code stays in the message, not in `status`: `status` is an HTTP
  // status, and an SMTP 550 is not an HTTP anything.
  if (typeof e.responseCode === "number") {
    return { error: message, retryable: e.responseCode < 500 };
  }
  const permanent = e.code === "EAUTH" || e.code === "EENVELOPE" || e.code === "EMESSAGE";
  return { error: message, retryable: !permanent };
}
