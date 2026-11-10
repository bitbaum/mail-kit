import { describe, expect, it } from "vitest";
import {
  listUnsubscribeHeaders,
  renderMail,
  signUnsubscribe,
  verifyUnsubscribe,
  type MailBrand,
  type MailContent,
} from "../src/index.js";

const BRAND: MailBrand = {
  name: "Heidi",
  url: "https://heidi.example",
  accent: "#d9232d",
  onAccent: "#ffffff",
};
const CONTENT: MailContent = {
  lang: "de-CH",
  preheader: "Acht Fragen warten",
  heading: "Heute sind **8 Fragen** fällig",
  blocks: [
    { type: "paragraph", text: "Kurz vor dem Vergessen." },
    {
      type: "stats",
      items: [
        { value: "8", label: "fällig" },
        { value: "3", label: "Tage in Folge" },
      ],
    },
    { type: "button", label: "Jetzt üben", url: "https://heidi.example/practice" },
    { type: "note", text: "Der Link gilt zehn Minuten." },
  ],
  footer: {
    reason: "Sie bekommen das, weil Sie Erinnerungen eingeschaltet haben.",
    unsubscribe: { label: "Abmelden", url: "https://heidi.example/u/abc" },
    preferences: { label: "Einstellungen", url: "https://heidi.example/settings" },
  },
};

describe("renderMail", () => {
  it("renders a full document with a text twin carrying every link", () => {
    const { html, text } = renderMail(BRAND, CONTENT);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('lang="de-CH"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("<strong>8 Fragen</strong>");
    expect(text).toContain("Heute sind 8 Fragen fällig");
    expect(text).toContain("Jetzt üben: https://heidi.example/practice");
    expect(text).toContain("Abmelden: https://heidi.example/u/abc");
    expect(text).not.toContain("<");
  });

  it("escapes everything an app hands it", () => {
    const { html } = renderMail(BRAND, {
      ...CONTENT,
      heading: "<img src=x onerror=alert(1)>",
      blocks: [
        { type: "paragraph", text: '"><script>alert(1)</script>' },
        { type: "list", items: ["<b>x</b>"] },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses a link that is not http(s) or mailto", () => {
    expect(() =>
      renderMail(BRAND, {
        ...CONTENT,
        blocks: [{ type: "button", label: "x", url: "javascript:alert(1)" }],
      }),
    ).toThrow(/refusing a link/);
  });

  it("refuses a brand colour that is not a hex", () => {
    expect(() => renderMail({ ...BRAND, accent: "red" }, CONTENT)).toThrow(/accent/);
  });

  it("says why, and may omit unsubscribe only by writing null", () => {
    const { html, text } = renderMail(BRAND, {
      ...CONTENT,
      footer: { reason: "Sie haben diesen Link gerade angefordert.", unsubscribe: null },
    });
    expect(html).toContain("Sie haben diesen Link gerade angefordert.");
    expect(html).not.toContain("Abmelden");
    expect(text).not.toContain("Abmelden");
  });

  it("supports right-to-left text", () => {
    expect(renderMail(BRAND, { ...CONTENT, lang: "ar", dir: "rtl" }).html).toContain('dir="rtl"');
  });
});

describe("unsubscribe", () => {
  it("round-trips and rejects a forged or damaged token", () => {
    const token = signUnsubscribe("secret", { user: "u1", list: "due" });
    expect(verifyUnsubscribe("secret", token)).toEqual({ user: "u1", list: "due" });
    expect(verifyUnsubscribe("other", token)).toBeNull();
    expect(verifyUnsubscribe("secret", `${token}x`)).toBeNull();
    expect(verifyUnsubscribe("secret", "garbage")).toBeNull();
    const [body] = token.split(".");
    expect(verifyUnsubscribe("secret", `${body}.AAAA`)).toBeNull();
  });

  it("builds the one-click headers and insists on https", () => {
    expect(listUnsubscribeHeaders("https://x.example/u/1")).toEqual({
      "List-Unsubscribe": "<https://x.example/u/1>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(() => listUnsubscribeHeaders("http://x.example/u/1")).toThrow();
  });
});
