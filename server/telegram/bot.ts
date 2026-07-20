import { Telegraf, type Context } from "telegraf";
import { commandHandlers } from "./commands.js";
import { conversationHandlers } from "./handlers.js";
import { userService } from "../services/user.js";
import { getBotToken } from "../utils/env.js";
import { isTelegramUserAllowed } from "../utils/access-control.js";
import { logger } from "../utils/logger.js";
import {
  escapeTelegramText,
  sanitizeTelegramHtml,
  telegramHtmlToPlainText,
} from "../utils/telegram-html.js";

class BotService {
  private bot: Telegraf<Context> | null = null;
  private isStarted = false;

  private getBot(): Telegraf<Context> {
    if (!this.bot) throw new Error("Telegram bot is not initialized");
    return this.bot;
  }

  private setupMiddleware(): void {
    const bot = this.getBot();

    bot.use(async (ctx, next) => {
      if (ctx.from && !isTelegramUserAllowed(ctx.from.id)) {
        logger.warn("Rejected Telegram update from a user outside the allowlist", {
          updateType: ctx.updateType,
        });
        await ctx.reply("This bot is private. Ask its operator for access.");
        return;
      }
      await next();
    });

    bot.use(async (ctx, next) => {
      const startedAt = Date.now();
      logger.info("Telegram update received", { updateType: ctx.updateType });
      await next();
      logger.info("Telegram update processed", {
        updateType: ctx.updateType,
        durationMs: Date.now() - startedAt,
      });
    });

    bot.use(async (ctx, next) => {
      if (ctx.from) await userService.getOrCreateUser(ctx.from);
      await next();
    });

    bot.catch((error, ctx) => {
      logger.error("Telegram bot handler failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        updateType: ctx.updateType,
      });
      void ctx.reply("❌ Произошла ошибка. Попробуйте позже.").catch(() => undefined);
    });
  }

  private setupCommands(): void {
    const bot = this.getBot();
    bot.command("start", commandHandlers.start);
    bot.command("help", commandHandlers.help);
    bot.command("timezone", commandHandlers.timezone);
    bot.command("digest_add", commandHandlers.digestAdd);
    bot.command("digest_list", commandHandlers.digestList);
    bot.command("digest_edit", commandHandlers.digestEdit);
    bot.command("digest_delete", commandHandlers.digestDelete);
    bot.command("channel_add", commandHandlers.channelAdd);
    bot.command("channel_list", commandHandlers.channelList);
    bot.command("channel_remove", commandHandlers.channelRemove);
    bot.command("test_run", commandHandlers.testRun);
    bot.command("summary_model", commandHandlers.summaryModel);
    bot.command("stats", commandHandlers.stats);
    bot.command("errors_last", commandHandlers.errorsLast);
    bot.command("user", commandHandlers.userInfo);
    bot.command("runs_today", commandHandlers.runsToday);
  }

  private setupHandlers(): void {
    const bot = this.getBot();
    bot.on("text", conversationHandlers.handleText);
    bot.on("callback_query", conversationHandlers.handleCallbackQuery);
  }

  async start(): Promise<void> {
    if (this.isStarted) return;

    this.bot = new Telegraf(getBotToken(), { handlerTimeout: 180_000 });
    this.setupMiddleware();
    this.setupCommands();
    this.setupHandlers();

    const bot = this.getBot();
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    this.isStarted = true;
    logger.info("Telegram bot started in polling mode");
  }

  async stop(): Promise<void> {
    if (!this.isStarted || !this.bot) return;
    this.bot.stop();
    this.isStarted = false;
    logger.info("Telegram bot stopped");
  }

  async canReachUser(chatId: string | number): Promise<boolean> {
    try {
      await this.getBot().telegram.sendChatAction(this.numericChatId(chatId), "typing");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return !(message.includes("bot was blocked by the user") || message.includes("403"));
    }
  }

  async sendMessage(chatId: string | number, text: string, options?: object): Promise<void> {
    const numericChatId = this.numericChatId(chatId);
    const formatted = sanitizeTelegramHtml(text);
    const maxLength = 4_000;

    if (formatted.length <= maxLength) {
      await this.getBot().telegram.sendMessage(numericChatId, formatted, {
        link_preview_options: { is_disabled: true },
        ...options,
        parse_mode: "HTML",
      });
      return;
    }

    const plainText = telegramHtmlToPlainText(formatted);
    const chunks = this.splitMessage(plainText, maxLength);
    logger.info("Splitting a long Telegram message", {
      totalLength: formatted.length,
      chunksCount: chunks.length,
    });

    for (const [index, chunk] of chunks.entries()) {
      await this.getBot().telegram.sendMessage(numericChatId, escapeTelegramText(chunk), {
        link_preview_options: { is_disabled: true },
        ...options,
        parse_mode: "HTML",
      });
      if (index < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  private numericChatId(chatId: string | number): number {
    const value = typeof chatId === "string" ? Number(chatId) : chatId;
    if (!Number.isSafeInteger(value)) throw new Error("Invalid Telegram chat ID");
    return value;
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();

    while (remaining.length > maxLength) {
      const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
      const lineBreak = remaining.lastIndexOf("\n", maxLength);
      const space = remaining.lastIndexOf(" ", maxLength);
      const splitAt = Math.max(paragraphBreak, lineBreak, space, 1);
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining) chunks.push(remaining);
    return chunks;
  }

  getBotInfo(): unknown {
    return this.bot?.botInfo;
  }
}

export const botService = new BotService();
