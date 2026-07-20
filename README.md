# Morningfeed Bot

Morningfeed Bot is a self-hosted Telegram bot that turns posts from public Telegram channels into concise, scheduled AI digests. It is useful when you follow many channels but want one daily or weekly summary instead of reading every post.

The bot can:

- create multiple daily or weekly digests;
- collect posts from public Telegram channels without joining them;
- summarize the posts with OpenAI;
- deliver summaries in each user's IANA timezone;
- manage channels and schedules through Telegram commands;
- restrict access to an explicit Telegram user allowlist;
- store configuration and run history in PostgreSQL.

There is intentionally no web dashboard. The previous UI was removed because it was unused; all user-facing actions happen inside Telegram. The HTTP server only exposes `GET /health` for hosting health checks.

## How it works

1. A user creates a digest and adds public channel usernames.
2. The scheduler calculates the daily or weekly collection window in the user's timezone.
3. The bot reads public channel pages from `t.me`, with rate limiting and bounded retries.
4. Post text is sent to OpenAI for summarization.
5. The generated Telegram HTML is sanitized, and only links to `t.me` or `telegram.me` are allowed.
6. The final digest is delivered to the user in Telegram.

The scraper depends on Telegram's public HTML pages, which are not a documented API and may change. Private channels are not supported.

## Requirements

- Node.js 20 or newer
- PostgreSQL
- a Telegram bot token from BotFather
- an OpenAI API key
- your numeric Telegram user ID

## Quick start

```bash
git clone https://github.com/shelovesclock/morningfeed_bot.git
cd morningfeed_bot
cp .env.example .env
npm ci
npm run db:push
npm run dev
```

Before starting the bot, edit `.env` and set at least:

```dotenv
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
OPENAI_API_KEY=your-openai-api-key
DATABASE_URL=postgresql://user:password@localhost:5432/morningfeed
ALLOWED_TELEGRAM_IDS=123456789
ADMIN_TELEGRAM_IDS=123456789
```

Use comma-separated IDs to allow more than one person:

```dotenv
ALLOWED_TELEGRAM_IDS=123456789,987654321
```

Admins are automatically allowed. By default, startup fails when no allowlist is configured. You can deliberately make the bot available to everyone with `ALLOW_ALL_USERS=true`, but doing so lets any Telegram user consume your OpenAI quota.

For a production build:

```bash
npm run build
npm start
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram Bot API token. |
| `OPENAI_API_KEY` | Yes | API key used for digest generation. |
| `DATABASE_URL` | Yes | PostgreSQL connection string used by Prisma. |
| `ALLOWED_TELEGRAM_IDS` | By default | Comma-separated Telegram user IDs that may use the bot. |
| `ADMIN_TELEGRAM_IDS` | No | Comma-separated IDs that receive bot admin permissions and are also allowed. |
| `ALLOW_ALL_USERS` | No | Set to `true` only to disable the allowlist deliberately. Defaults to `false`. |
| `OPENAI_SUMMARY_MODEL` | No | Primary model. Defaults to `gpt-5-mini`. |
| `OPENAI_FALLBACK_MODEL` | No | Fallback model. Defaults to `gpt-4.1-mini`. |
| `OPENAI_ENDPOINT` | No | `auto`, `responses`, or `chat`. Defaults to `auto`. |
| `OPENAI_DEBUG` | No | Enables extra request metadata logging; prompt and response text are not logged. |
| `PORT` | No | Health server port. Defaults to `5000`. |
| `HOST` | No | Health server bind address. Defaults to `0.0.0.0`. |
| `LOG_LEVEL` | No | Winston log level. Defaults to `info` in production. |

See [`.env.example`](.env.example) for the complete template. Never commit `.env` or real credentials.

## Telegram commands

- `/start` — introduction and setup guidance
- `/help` — command overview
- `/timezone` — set an IANA timezone such as `Europe/Lisbon`
- `/digest_add` — create a digest
- `/digest_list` — list digests
- `/digest_edit` — edit a digest
- `/digest_delete` — delete a digest
- `/channel_add` — add public channels
- `/channel_list` — list channels in a digest
- `/channel_remove` — remove a channel
- `/test_run` — generate a digest immediately
- `/summary_model` — change summary settings

Admin IDs can also use `/stats`, `/errors_last`, `/user`, and `/runs_today`.

## Development checks

```bash
npm run check
npm test
npm run build
npm run security:audit
```

`npm run db:push` synchronizes the Prisma schema with the configured database. Back up production data before applying schema changes.

## Security and privacy

- Access is deny-by-default unless an allowlist or explicit public mode is configured.
- Secrets are read from environment variables and ignored by Git.
- Incoming Telegram message bodies, Telegram IDs, usernames, and OpenAI prompt text are not written to application logs.
- Logger metadata is recursively redacted for common credential fields and secret formats.
- Generated HTML is reduced to a small Telegram-compatible allowlist; non-Telegram links are removed.
- Concurrent runs of the same digest are rejected to limit duplicate work and cost.
- Scheduled runs are skipped when their owner is no longer on the allowlist.

The database still contains Telegram profile fields, digest configuration, generated summaries, usage records, and error metadata. Protect the database, use TLS in production, restrict network access, and define an appropriate retention policy. Text collected from public channels is sent to OpenAI for summarization, so review OpenAI's data controls for your deployment.

No security review can guarantee that software is free of every vulnerability. Keep Node.js and dependencies updated, run `npm audit`, rotate any credential that may have been exposed, and review changes before deployment.

## License

Morningfeed Bot is released under the [MIT License](LICENSE). You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies, subject to the license notice.
