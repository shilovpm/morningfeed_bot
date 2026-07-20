import * as cheerio from "cheerio";

const ALLOWED_TAGS = new Set(["a", "b", "em", "i", "strong"]);
const ALLOWED_LINK_HOSTS = new Set(["t.me", "telegram.me"]);

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeTelegramUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !ALLOWED_LINK_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeTelegramHtml(input: string): string {
  const $ = cheerio.load(input, null, false);
  $("script, style").remove();

  $("*").each((_index, element) => {
    if (!("tagName" in element) || !("attribs" in element)) return;
    const tag = element.tagName.toLowerCase();
    const node = $(element);

    if (!ALLOWED_TAGS.has(tag)) {
      node.replaceWith(escapeHtml(node.text()));
      return;
    }

    if (tag === "a") {
      const href = safeTelegramUrl(node.attr("href"));
      if (!href) {
        node.replaceWith(escapeHtml(node.text()));
        return;
      }
      for (const attribute of Object.keys(element.attribs || {})) node.removeAttr(attribute);
      node.attr("href", href);
      return;
    }

    for (const attribute of Object.keys(element.attribs || {})) node.removeAttr(attribute);
  });

  return $.root().html() || "";
}

export function telegramHtmlToPlainText(input: string): string {
  const sanitized = sanitizeTelegramHtml(input);
  const $ = cheerio.load(sanitized, null, false);
  $("a").each((_index, element) => {
    const node = $(element);
    const href = node.attr("href");
    node.replaceWith(`${node.text()}${href ? ` (${href})` : ""}`);
  });
  return $.root().text();
}

export function escapeTelegramText(input: string): string {
  return escapeHtml(input);
}
