import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isMailConfigured,
  mailHealth,
  mailTransport,
  sendMail,
  smtpConfigFrom,
} from "../src/index.js";

/**
 * A minimal SMTP server: enough of RFC 5321 for nodemailer to log in and hand
 * over one message, so the test proves the real wire path, not a mock of it.
 */
interface Received {
  auth?: string;
  mailFrom?: string;
  rcptTo: string[];
  data: string;
}
let server: Server;
let port = 0;
const received: Received[] = [];
let rejectRcpt = false;

beforeAll(async () => {
  server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current: Received = { rcptTo: [], data: "" };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 test ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(current);
            current = { rcptTo: [], data: "" };
            reply("250 2.0.0 queued");
          } else current.data += `${line}\n`;
          continue;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-test\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (verb === "AUTH") {
          current.auth = Buffer.from(line.split(" ")[2] ?? "", "base64").toString("utf8");
          reply(
            current.auth === "\u0000app\u0000right" ? "235 2.7.0 ok" : "535 5.7.8 Login denied",
          );
        } else if (verb === "MAIL") {
          current.mailFrom = line;
          reply("250 ok");
        } else if (verb === "RCPT") {
          current.rcptTo.push(line);
          reply(rejectRcpt ? "550 5.1.1 no such user" : "250 ok");
        } else if (verb === "DATA") {
          inData = true;
          reply("354 go");
        } else if (verb === "RSET" || verb === "NOOP") reply("250 ok");
        else if (verb === "QUIT") {
          reply("221 bye");
          socket.end();
        } else reply("502 no");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const env = () => ({
  MAIL_TRANSPORT: "smtp",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(port),
  SMTP_USER: "app",
  SMTP_PASS: "right",
  SMTP_FROM: "Evig <noreply@evig.example>",
  APP_URL: "https://evig.orangecat.ch",
});

describe("choosing the transport", () => {
  it("is Resend unless SMTP is asked for, and an unknown value is refused", async () => {
    expect(mailTransport({})).toBe("resend");
    expect(mailTransport({ SMTP_HOST: "mail.example" })).toBe("resend");
    expect(mailTransport({ MAIL_TRANSPORT: "SMTP" })).toBe("smtp");
    expect(mailTransport({ MAIL_TRANSPORT: "sendgrid" })).toBeUndefined();
    const result = await sendMail(
      { to: "a@b.ch", subject: "s", text: "t" },
      { env: { MAIL_TRANSPORT: "sendgrid" } },
    );
    expect(result).toMatchObject({ sent: false, retryable: false });
  });

  it("counts SMTP configured only with a host, and a user only with its password", () => {
    expect(isMailConfigured({ MAIL_TRANSPORT: "smtp" })).toBe(false);
    expect(isMailConfigured({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", SMTP_USER: "u" })).toBe(
      false,
    );
    expect(isMailConfigured({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", SMTP_PORT: "x" })).toBe(
      false,
    );
    expect(isMailConfigured({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h" })).toBe(true);
    expect(
      isMailConfigured({}, { transport: "smtp", smtp: { host: "h", user: "u", pass: "p" } }),
    ).toBe(true);
    // SMTP settings alone do not make a Resend app configured.
    expect(isMailConfigured({ SMTP_HOST: "h" })).toBe(false);
  });

  it("reads SMTP_* from the env, or takes the app's own settings", () => {
    expect(smtpConfigFrom({ SMTP_HOST: "h", SMTP_PORT: "465", SMTP_SECURE: "true" })).toEqual({
      host: "h",
      port: 465,
      secure: true,
    });
    expect(smtpConfigFrom({}, { host: "mine" })).toEqual({ host: "mine" });
  });
});

describe("sending over SMTP", () => {
  it("logs in and hands over the message, with Reply-To, headers and an attachment", async () => {
    received.length = 0;
    const result = await sendMail(
      {
        to: "anna@example.org",
        subject: "Grüezi",
        text: "Hallo Anna",
        headers: { "X-Test": "1" },
        attachments: [
          {
            filename: "a.txt",
            content: new TextEncoder().encode("hello"),
            contentType: "text/plain",
          },
        ],
      },
      { env: env() },
    );
    expect(result.sent).toBe(true);
    const mail = received[0]!;
    expect(mail.auth).toBe("\u0000app\u0000right");
    expect(mail.mailFrom).toContain("<noreply@evig.example>");
    expect(mail.rcptTo[0]).toContain("<anna@example.org>");
    expect(mail.data).toMatch(/^Reply-To: hello@evig\.orangecat\.ch$/m);
    expect(mail.data).toMatch(/^X-Test: 1$/m);
    expect(mail.data).toContain(Buffer.from("hello").toString("base64"));
    expect(mail.data).toMatch(/^Subject: =\?UTF-8\?/m);
  });

  it("answers a refused login as a permanent failure, not a throw", async () => {
    const result = await sendMail(
      { to: "a@b.ch", subject: "s", text: "t" },
      { env: { ...env(), SMTP_PASS: "wrong" } },
    );
    expect(result).toMatchObject({ sent: false, retryable: false });
    if (!result.sent) {
      expect(result.error).toContain("Login denied");
      expect(result.status).toBeUndefined();
    }
  });

  it("does not call a message with no accepted recipient sent", async () => {
    rejectRcpt = true;
    try {
      const result = await sendMail({ to: "nobody@b.ch", subject: "s", text: "t" }, { env: env() });
      expect(result).toMatchObject({ sent: false, retryable: false });
    } finally {
      rejectRcpt = false;
    }
  });

  it("marks an unreachable server retryable", async () => {
    const result = await sendMail(
      { to: "a@b.ch", subject: "s", text: "t" },
      { env: { ...env(), SMTP_PORT: "1" }, timeoutMs: 2000 },
    );
    expect(result).toMatchObject({ sent: false, retryable: true });
  });

  it("needs its own sender: the shared Resend domain is not the app's mail server's", async () => {
    const rest: Record<string, string | undefined> = { ...env(), SMTP_FROM: undefined };
    const result = await sendMail(
      { to: "a@b.ch", subject: "s", text: "t" },
      { env: { ...rest, RESEND_FROM: "X <x@fleetcrown.orangecat.ch>" } },
    );
    expect(result).toMatchObject({ sent: false, retryable: false });
    if (!result.sent) expect(result.error).toContain("SMTP_FROM");
  });

  it("checks health by logging in, without sending", async () => {
    received.length = 0;
    expect(await mailHealth({ env: env() })).toEqual({ ok: true });
    expect((await mailHealth({ env: { ...env(), SMTP_PASS: "wrong" } })).ok).toBe(false);
    expect(received).toHaveLength(0);
  });
});
