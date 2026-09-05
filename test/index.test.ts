import { afterEach, describe, expect, it, vi } from "vitest";
import {
  conventionalFrom,
  fromAddress,
  isMailConfigured,
  mailHealth,
  sendMail,
  usesSandboxSender,
} from "../src/index.js";

const GOOD_ENV = {
  RESEND_API_KEY: "re_test_123",
  RESEND_FROM: "App <app@fleetcrown.orangecat.ch>",
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isMailConfigured", () => {
  it("false without a key, with a placeholder key, and with literal 'undefined'", () => {
    expect(isMailConfigured({})).toBe(false);
    expect(isMailConfigured({ RESEND_API_KEY: "re_placeholder_xxx" })).toBe(false);
    expect(isMailConfigured({ RESEND_API_KEY: "undefined" })).toBe(false);
  });

  it("true with a real key", () => {
    expect(isMailConfigured(GOOD_ENV)).toBe(true);
  });

  it("a sandbox sender counts as unconfigured in production only", () => {
    const sandbox = { RESEND_API_KEY: "re_x", RESEND_FROM: "Dev <a@resend.dev>" };
    expect(isMailConfigured({ ...sandbox, NODE_ENV: "production" })).toBe(false);
    expect(isMailConfigured({ ...sandbox, NODE_ENV: "development" })).toBe(true);
  });
});

describe("sender helpers", () => {
  it("usesSandboxSender sees through display names", () => {
    expect(usesSandboxSender("Foo <onboarding@resend.dev>")).toBe(true);
    expect(usesSandboxSender("app@fleetcrown.orangecat.ch")).toBe(false);
  });

  it("fromAddress reads RESEND_FROM, empty = undefined", () => {
    expect(fromAddress(GOOD_ENV)).toBe(GOOD_ENV.RESEND_FROM);
    expect(fromAddress({ RESEND_FROM: "  " })).toBeUndefined();
    expect(fromAddress({})).toBeUndefined();
  });

  it("conventionalFrom builds the fleet sender", () => {
    expect(conventionalFrom("Evig")).toBe("Evig <evig@fleetcrown.orangecat.ch>");
    expect(conventionalFrom("Surf Your Life")).toBe(
      "Surf Your Life <surf-your-life@fleetcrown.orangecat.ch>",
    );
  });
});

describe("sendMail", () => {
  it("returns sent:true with the message id on 200", async () => {
    const fetchMock = mockFetch(200, { id: "msg_1" });
    const result = await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: GOOD_ENV });
    expect(result).toEqual({ sent: true, id: "msg_1" });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.from).toBe(GOOD_ENV.RESEND_FROM);
    expect(body.to).toEqual(["a@b.ch"]);
  });

  it("never throws: unconfigured env returns an honest failure", async () => {
    const result = await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: {} });
    expect(result).toMatchObject({ sent: false, retryable: false });
    expect((result as { error: string }).error).toContain("RESEND_API_KEY");
  });

  it("missing sender and missing body are non-retryable config errors", async () => {
    const env = { RESEND_API_KEY: "re_x" };
    expect(await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env })).toMatchObject({
      sent: false,
      retryable: false,
    });
    expect(await sendMail({ to: "a@b.ch", subject: "s" }, { env: GOOD_ENV })).toMatchObject({
      sent: false,
      retryable: false,
    });
  });

  it("429 and 5xx are retryable, 4xx is not", async () => {
    mockFetch(429, { message: "quota" });
    expect(
      await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: GOOD_ENV }),
    ).toMatchObject({
      sent: false,
      status: 429,
      retryable: true,
    });
    mockFetch(500, {});
    expect(
      await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: GOOD_ENV }),
    ).toMatchObject({
      sent: false,
      status: 500,
      retryable: true,
    });
    mockFetch(403, { message: "domain is not verified" });
    const forbidden = await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: GOOD_ENV });
    expect(forbidden).toMatchObject({ sent: false, status: 403, retryable: false });
    expect((forbidden as { error: string }).error).toContain("not verified");
  });

  it("network failure is retryable, not thrown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    expect(
      await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: GOOD_ENV }),
    ).toMatchObject({
      sent: false,
      retryable: true,
    });
  });

  it("a 200 without an id is a failure, not fabricated success", async () => {
    mockFetch(200, {});
    expect(
      await sendMail({ to: "a@b.ch", subject: "s", text: "t" }, { env: GOOD_ENV }),
    ).toMatchObject({
      sent: false,
      retryable: true,
    });
  });

  it("maps cc/bcc/replyTo/attachments/idempotency to the wire format", async () => {
    const fetchMock = mockFetch(200, { id: "msg_2" });
    await sendMail(
      {
        to: ["a@b.ch", "c@d.ch"],
        cc: "e@f.ch",
        bcc: ["g@h.ch"],
        replyTo: "reply@b.ch",
        subject: "s",
        html: "<p>x</p>",
        attachments: [
          { filename: "x.pdf", content: new Uint8Array([1, 2, 3]), contentType: "application/pdf" },
          { filename: "y.txt", content: "YWJj" },
        ],
      },
      { env: GOOD_ENV, idempotencyKey: "job-42" },
    );
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("job-42");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(["a@b.ch", "c@d.ch"]);
    expect(body.cc).toEqual(["e@f.ch"]);
    expect(body.bcc).toEqual(["g@h.ch"]);
    expect(body.reply_to).toBe("reply@b.ch");
    expect(body.attachments).toEqual([
      {
        filename: "x.pdf",
        content: Buffer.from([1, 2, 3]).toString("base64"),
        content_type: "application/pdf",
      },
      { filename: "y.txt", content: "YWJj" },
    ]);
  });
});

describe("mailHealth", () => {
  it("reports domains on a valid key", async () => {
    mockFetch(200, { data: [{ name: "fleetcrown.orangecat.ch", status: "verified" }] });
    expect(await mailHealth({ env: GOOD_ENV })).toEqual({
      ok: true,
      domains: [{ name: "fleetcrown.orangecat.ch", status: "verified" }],
    });
  });

  it("reports not-ok on bad key / unconfigured", async () => {
    mockFetch(401, {});
    expect(await mailHealth({ env: GOOD_ENV })).toMatchObject({ ok: false });
    expect(await mailHealth({ env: {} })).toEqual({ ok: false, error: "not configured" });
  });
});
