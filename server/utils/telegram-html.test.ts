import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeTelegramHtml,
  telegramHtmlToPlainText,
} from "./telegram-html.js";

test("preserves the small Telegram HTML allowlist", () => {
  assert.equal(
    sanitizeTelegramHtml('<b>News</b> <a href="https://t.me/example/42">source</a>'),
    '<b>News</b> <a href="https://t.me/example/42">source</a>',
  );
});

test("removes unsafe tags, attributes, and non-Telegram links", () => {
  assert.equal(
    sanitizeTelegramHtml(
      '<script>alert(1)</script><b onclick="x">safe</b> <a href="https://example.com/phish">click</a>',
    ),
    "<b>safe</b> click",
  );
});

test("plain-text conversion keeps a safe source URL", () => {
  assert.equal(
    telegramHtmlToPlainText('<a href="https://t.me/example/42">source</a>'),
    "source (https://t.me/example/42)",
  );
});
