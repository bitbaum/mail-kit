/**
 * One email layout for the whole fleet.
 *
 * Eleven apps sent mail and nine of them sent it plain, or as a template of
 * their own with the brand colour and the product's name written into it
 * (OrangeCat's, which this is extracted from, said "OrangeCat" in its header
 * and could not be reused). An app supplies a BRAND (name, colours, logo) and
 * CONTENT (blocks of plain text); the layout, the dark mode, the Outlook
 * button, the plain-text twin and the footer rules live here, once.
 *
 * WHY THE CONTENT IS PLAIN TEXT AND NOT HTML. Every string is escaped here.
 * A template that takes `body: string` of HTML makes every caller responsible
 * for escaping a name, a title or a message somebody typed — and one of them
 * will forget. The only markup an app can ask for is `**bold**`.
 *
 * WHY THE FOOTER IS A REQUIRED KEY. Bulk mail without a working unsubscribe is
 * how a sender ends up in spam and how a product gets hated. `footer.unsubscribe`
 * is `{label, url}` or `null`, and `null` is for mail the person asked for this
 * minute (a sign-in link), where "unsubscribe" would mean "stop letting me in".
 * A newsletter template cannot omit it by forgetting; it has to write `null`.
 *
 * Pure: no I/O, no dependencies. Returns `{ html, text }` for `sendMail`.
 */

export interface MailBrand {
  /** The product's name, shown in the header and the footer. */
  name: string;
  /** Where the name links to. */
  url: string;
  /** The action colour: buttons, the thin rule, links. A 6-digit hex. */
  accent: string;
  /** Text on `accent`. A 6-digit hex that passes AA against it. */
  onAccent: string;
  /** Brighter accent for dark mode, where `accent` can be too dark to read as a link. */
  accentDark?: string;
  /** Body ink in light mode. Default near-black. */
  ink?: string;
  /**
   * A PNG at least 2x its shown size (SVG is not supported in Gmail or
   * Outlook). Shown 28px high before the name. Optional: the name alone is a
   * perfectly good header.
   */
  logoUrl?: string;
  /** A line under the footer links, e.g. where the product is based. */
  footerLine?: string;
}

export type MailBlock =
  | { type: "paragraph"; text: string }
  | { type: "button"; label: string; url: string }
  /** A text link, for the second thing somebody might do. */
  | { type: "link"; label: string; url: string }
  /** A code to type on another device: big, spaced, selectable. */
  | { type: "code"; code: string; label?: string }
  /** Two or three numbers that say where you stand. */
  | { type: "stats"; items: { value: string; label: string }[] }
  | { type: "list"; items: string[] }
  | { type: "quote"; text: string; cite?: string }
  /** Small, muted: expiry, "if you did not ask for this". */
  | { type: "note"; text: string };

export interface MailFooter {
  /** Why this person is getting this mail. Always said. */
  reason: string;
  /** `null` ONLY for mail the person asked for this minute. */
  unsubscribe: { label: string; url: string } | null;
  /** Where they change what they get. */
  preferences?: { label: string; url: string };
}

export interface MailContent {
  /** BCP 47 language of the words; sets `lang` and hyphenation. */
  lang: string;
  /** Right-to-left text. */
  dir?: "ltr" | "rtl";
  /** The inbox preview line. Write it; an empty one shows the first words of the body. */
  preheader: string;
  heading: string;
  blocks: MailBlock[];
  footer: MailFooter;
}

export interface RenderedMail {
  html: string;
  text: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escaped, then `**bold**`: the one piece of markup an app can ask for. */
function inline(value: string): string {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function plain(value: string): string {
  return value.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function safeUrl(url: string): string {
  if (!SAFE_URL.test(url))
    throw new Error(`mail-kit: refusing a link that is not http(s) or mailto: ${url.slice(0, 40)}`);
  return escapeHtml(url);
}

function checkBrand(brand: MailBrand): void {
  for (const [key, value] of [
    ["accent", brand.accent],
    ["onAccent", brand.onAccent],
    ["accentDark", brand.accentDark],
    ["ink", brand.ink],
  ] as const) {
    if (value !== undefined && !HEX.test(value))
      throw new Error(`mail-kit: brand.${key} must be a 6-digit hex`);
  }
}

// System fonts, deliberately: webfonts fail in most mail clients, and a
// fallback chosen by the client looks accidental. These are the faces the
// platforms already ship and that sit well beside a geometric sans.
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const LIGHT = {
  page: "#f3f3f1",
  card: "#ffffff",
  rule: "#e4e4e0",
  soft: "#f3f3f1",
  ink2: "#4a4a47",
  muted: "#74746f",
};
const DARK = {
  page: "#0e0e0d",
  card: "#1a1a19",
  rule: "#2e2e2c",
  soft: "#242423",
  ink: "#f2f2ef",
  ink2: "#c9c9c4",
  muted: "#9a9a94",
};

function block(b: MailBlock, brand: MailBrand, ink: string): string {
  switch (b.type) {
    case "paragraph":
      return `<tr><td class="ink2" style="padding:0 0 16px;font-size:16px;line-height:1.6;color:${LIGHT.ink2};">${inline(b.text)}</td></tr>`;
    case "button": {
      const url = safeUrl(b.url);
      return `<tr><td class="btn" style="padding:12px 0 24px;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="17%" stroke="f" fillcolor="${brand.accent}"><w:anchorlock/><center style="color:${brand.onAccent};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${escapeHtml(b.label)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a class="cta" href="${url}" style="display:inline-block;background:${brand.accent};color:${brand.onAccent};text-decoration:none;font-size:16px;font-weight:700;line-height:1;padding:16px 28px;border-radius:8px;mso-hide:all;">${escapeHtml(b.label)}</a><!--<![endif]-->
</td></tr>`;
    }
    case "link":
      return `<tr><td style="padding:0 0 16px;font-size:15px;line-height:1.5;"><a class="lnk" href="${safeUrl(b.url)}" style="color:${brand.accent};font-weight:600;text-decoration:underline;">${escapeHtml(b.label)}</a></td></tr>`;
    case "code":
      return `<tr><td style="padding:4px 0 20px;">${b.label ? `<div class="muted" style="font-size:13px;line-height:1.4;color:${LIGHT.muted};padding-bottom:8px;">${inline(b.label)}</div>` : ""}<div class="soft ink" style="display:inline-block;background:${LIGHT.soft};border-radius:8px;padding:14px 20px;font-family:${MONO};font-size:28px;font-weight:700;letter-spacing:6px;color:${ink};">${escapeHtml(b.code)}</div></td></tr>`;
    case "stats": {
      const cells = b.items
        .map(
          (s) =>
            `<td class="soft" valign="top" style="background:${LIGHT.soft};border-radius:8px;padding:14px 16px;"><div class="ink" style="font-size:28px;line-height:1.1;font-weight:700;color:${ink};">${escapeHtml(s.value)}</div><div class="muted" style="font-size:13px;line-height:1.4;color:${LIGHT.muted};padding-top:4px;">${escapeHtml(s.label)}</div></td>`,
        )
        .join('<td width="8" style="font-size:0;line-height:0;">&nbsp;</td>');
      return `<tr><td style="padding:4px 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>`;
    }
    case "list":
      return `<tr><td class="ink2" style="padding:0 0 16px;font-size:16px;line-height:1.6;color:${LIGHT.ink2};">${b.items
        .map(
          (item) =>
            `<div style="padding:0 0 6px 18px;text-indent:-18px;">&bull;&nbsp;&nbsp;${inline(item)}</div>`,
        )
        .join("")}</td></tr>`;
    case "quote":
      return `<tr><td style="padding:4px 0 20px;"><div class="bar ink" style="border-left:3px solid ${brand.accent};padding:2px 0 2px 16px;font-size:18px;line-height:1.5;color:${ink};">${inline(b.text)}${b.cite ? `<div class="muted" style="font-size:13px;color:${LIGHT.muted};padding-top:6px;">${escapeHtml(b.cite)}</div>` : ""}</div></td></tr>`;
    case "note":
      return `<tr><td class="muted" style="padding:0 0 12px;font-size:13px;line-height:1.5;color:${LIGHT.muted};">${inline(b.text)}</td></tr>`;
  }
}

export function renderMail(brand: MailBrand, content: MailContent): RenderedMail {
  checkBrand(brand);
  const ink = brand.ink ?? "#161615";
  const accentDark = brand.accentDark ?? brand.accent;
  const dir = content.dir ?? "ltr";
  const { footer } = content;

  const links = [
    footer.preferences
      ? `<a class="lnk2" href="${safeUrl(footer.preferences.url)}" style="color:${LIGHT.muted};text-decoration:underline;">${escapeHtml(footer.preferences.label)}</a>`
      : "",
    footer.unsubscribe
      ? `<a class="lnk2" href="${safeUrl(footer.unsubscribe.url)}" style="color:${LIGHT.muted};text-decoration:underline;">${escapeHtml(footer.unsubscribe.label)}</a>`
      : "",
  ].filter(Boolean);

  const logo = brand.logoUrl
    ? `<img src="${safeUrl(brand.logoUrl)}" height="28" alt="" style="height:28px;width:auto;border:0;vertical-align:middle;margin-right:10px;" />`
    : "";

  const html = `<!DOCTYPE html>
<html lang="${escapeHtml(content.lang)}" dir="${dir}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(content.heading)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  a { text-decoration:underline; }
  @media only screen and (max-width:600px) {
    .card { width:100% !important; border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
    .px { padding-left:22px !important; padding-right:22px !important; }
    .cta { display:block !important; text-align:center !important; }
    h1 { font-size:24px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .page { background:${DARK.page} !important; }
    .card { background:${DARK.card} !important; border-color:${DARK.rule} !important; }
    .ink, h1 { color:${DARK.ink} !important; }
    .ink2 { color:${DARK.ink2} !important; }
    .muted, .lnk2 { color:${DARK.muted} !important; }
    .soft { background:${DARK.soft} !important; }
    .rule { border-color:${DARK.rule} !important; }
    .bar { border-color:${accentDark} !important; }
    .lnk { color:${accentDark} !important; }
    .top { border-bottom-color:${accentDark} !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${LIGHT.page};font-family:${SANS};color:${ink};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(content.preheader)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT.page};">
<tr><td align="center" style="padding:28px 12px 36px;">
<table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:100%;background:${LIGHT.card};border:1px solid ${LIGHT.rule};border-radius:14px;">
<tr><td class="px top" style="padding:22px 36px 18px;border-bottom:3px solid ${brand.accent};border-radius:14px 14px 0 0;">
<a href="${safeUrl(brand.url)}" class="ink" style="text-decoration:none;color:${ink};font-size:20px;font-weight:800;letter-spacing:-0.4px;">${logo}<span style="vertical-align:middle;">${escapeHtml(brand.name)}</span></a>
</td></tr>
<tr><td class="px" style="padding:32px 36px 12px;">
<h1 class="ink" style="margin:0 0 18px;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:-0.6px;color:${ink};">${inline(content.heading)}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${content.blocks.map((b) => block(b, brand, ink)).join("\n")}
</table>
</td></tr>
<tr><td class="px" style="padding:8px 36px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td class="rule" style="border-top:1px solid ${LIGHT.rule};padding:18px 0 0;font-size:12px;line-height:1.6;color:${LIGHT.muted};"><span class="muted">${inline(footer.reason)}</span>${links.length ? `<br /><span class="muted">${links.join(" &nbsp;&middot;&nbsp; ")}</span>` : ""}${brand.footerLine ? `<br /><span class="muted">${escapeHtml(brand.footerLine)}</span>` : ""}</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    plain(content.heading),
    "",
    ...content.blocks.flatMap((b): string[] => {
      switch (b.type) {
        case "paragraph":
        case "note":
          return [plain(b.text), ""];
        case "button":
        case "link":
          return [`${b.label}: ${b.url}`, ""];
        case "code":
          return [`${b.label ? `${plain(b.label)} ` : ""}${b.code}`, ""];
        case "stats":
          return [b.items.map((s) => `${s.value} ${s.label}`).join("  ·  "), ""];
        case "list":
          return [...b.items.map((i) => `- ${plain(i)}`), ""];
        case "quote":
          return [`"${plain(b.text)}"${b.cite ? ` — ${b.cite}` : ""}`, ""];
      }
    }),
    "--",
    plain(footer.reason),
    ...(footer.preferences ? [`${footer.preferences.label}: ${footer.preferences.url}`] : []),
    ...(footer.unsubscribe ? [`${footer.unsubscribe.label}: ${footer.unsubscribe.url}`] : []),
    ...(brand.footerLine ? [brand.footerLine] : []),
  ].join("\n");

  return { html, text };
}
