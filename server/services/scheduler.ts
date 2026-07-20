import cron, { type ScheduledTask as CronTask } from 'node-cron';
import { storage } from '../storage.js';
import { prisma } from '../database.js';
import { ingestionService } from './ingestion.js';
import { summarizerService } from './summarizer.js';
import { botService } from '../telegram/bot.js';
import { getNextScheduledTime } from '../utils/timezone.js';
import { logger } from '../utils/logger.js';
import { isTelegramUserAllowed } from '../utils/access-control.js';

interface ScheduledTask {
  digestId: string;
  task: CronTask;
}

class SchedulerService {
  private tasks: Map<string, ScheduledTask> = new Map();
  private runningDigestIds = new Set<string>();
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      await this.scheduleAllActiveDigests();
      this.isInitialized = true;
      logger.info('Scheduler service initialized');
    } catch (error) {
      logger.error('Failed to initialize scheduler', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  async scheduleAllActiveDigests(): Promise<void> {
    const activeDigests = await storage.getActiveDigests();
    
    for (const digest of activeDigests) {
      await this.scheduleDigest(digest.id);
    }
    
    logger.info('Scheduled all active digests', { count: activeDigests.length });
  }

  async scheduleDigest(digestId: string): Promise<void> {
    try {
      // Remove existing schedule if any
      await this.unscheduleDigest(digestId);

      const digest = await storage.getDigest(digestId);
      if (!digest || !digest.isActive) {
        logger.warn('Digest not found or inactive', { digestId });
        return;
      }

      if (!digest.userId) {
        logger.warn('Digest has no userId', { digestId });
        return;
      }

      const user = await storage.getUser(digest.userId);
      if (!user) {
        logger.warn('User not found for digest', { digestId, userId: digest.userId });
        return;
      }

      // Calculate next run time
      const nextRun = getNextScheduledTime(
        digest.localTime,
        user.timezone || 'UTC',
        digest.frequency as 'daily' | 'weekly',
        digest.weekday || undefined
      );

      // Create cron expression for the scheduled time
      const cronExpression = this.createCronExpression(
        digest.localTime,
        digest.frequency as 'daily' | 'weekly',
        digest.weekday || undefined,
        user.timezone || 'UTC'
      );

      // Schedule the task
      const task = cron.schedule(cronExpression, async () => {
        await this.executeDigest(digestId);
      }, {
        timezone: user.timezone || 'UTC'
      });

      this.tasks.set(digestId, { digestId, task });

      logger.info('Digest scheduled successfully', {
        digestId,
        nextRun: nextRun.toISOString(),
        cronExpression,
        timezone: user.timezone
      });

    } catch (error) {
      logger.error('Failed to schedule digest', {
        digestId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  async unscheduleDigest(digestId: string): Promise<void> {
    const existing = this.tasks.get(digestId);
    if (existing) {
      existing.task.stop();
      existing.task.destroy();
      this.tasks.delete(digestId);
      logger.info('Digest unscheduled', { digestId });
    }
  }

  private isDbConnectionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as any)?.code;
    if (code === 'P1001' || code === 'P1002' || code === 'P1017') return true;
    return msg.includes("Can't reach database server") ||
           msg.includes('terminating connection') ||
           (msg.includes('connection') && msg.includes('closed')) ||
           msg.includes('E57P01') ||
           msg.includes('ECONNREFUSED');
  }

  private async ensureDbConnection(): Promise<void> {
    try {
      await prisma.$connect();
      logger.info('Database connection ensured before digest execution');
    } catch (error) {
      logger.error('Failed to ensure database connection', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      throw error;
    }
  }

  async executeDigest(digestId: string): Promise<void> {
    if (this.runningDigestIds.has(digestId)) {
      logger.warn('Skipping overlapping digest execution', { digestId });
      return;
    }
    this.runningDigestIds.add(digestId);
    let runId: string | null = null;
    
    try {
      logger.info('Executing digest', { digestId });

      await this.ensureDbConnection();

      const digest = await storage.getDigest(digestId);
      if (!digest) {
        throw new Error('Digest not found');
      }

      if (!digest.userId) {
        throw new Error('Digest has no userId');
      }

      const user = await storage.getUser(digest.userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (!isTelegramUserAllowed(user.telegramId)) {
        logger.warn('Skipping digest for a user outside the current allowlist', {
          digestId,
          userId: user.id,
        });
        return;
      }

      // Pre-check: can we reach the user at all?
      // Cheap sendChatAction call — if user blocked the bot, skip this run silently.
      // No run record is created, no scraping/AI tokens are spent.
      // If user unblocks later, next scheduled run will proceed normally.
      const reachable = await botService.canReachUser(user.telegramId);
      if (!reachable) {
        logger.warn('User has blocked the bot — skipping digest run', {
          digestId,
          userId: user.id
        });
        return;
      }

      // Calculate time window BEFORE creating run
      const now = new Date();
      const scheduledFor = now;
      const windowEnd = now;
      const windowStart = new Date(now);
      
      if (digest.frequency === 'daily') {
        windowStart.setHours(windowStart.getHours() - 24);
      } else if (digest.frequency === 'weekly') {
        windowStart.setDate(windowStart.getDate() - 7);
      }

      // Create run with actual timestamps
      runId = await storage.createRun({
        digestId,
        status: 'running',
        scheduledFor,
        windowStart,
        windowEnd,
        postsCount: 0,
        tokensUsed: 0,
        summary: null,
        errorMessage: null,
        openaiRequestId: null,
        openaiModel: null,
        openaiEndpointType: null,
        openaiFinishReason: null,
        debugMetadata: null,
      });

      logger.info('Run created with correct timestamps', { 
        digestId, 
        runId,
        scheduledFor: scheduledFor.toISOString(),
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString()
      });

      const channels = await storage.getDigestChannels(digestId);
      if (channels.length === 0) {
        await storage.updateRun(runId, {
          status: 'empty',
          completedAt: new Date(),
          errorMessage: 'No channels configured'
        });
        
        await botService.sendMessage(
          user.telegramId,
          `📭 Дайджест "${digest.name}"\n\nНе настроены каналы для мониторинга. Добавьте каналы командой /channel_add ${digest.name}`
        );
        return;
      }

      // Collect posts from channels
      const channelUsernames = channels.map(c => c.username);
      const postsData = await ingestionService.collectPosts(
        channelUsernames,
        windowStart,
        windowEnd
      );

      const totalPosts = postsData.reduce((sum, ch) => sum + ch.posts.length, 0);

      if (totalPosts === 0) {
        await storage.updateRun(runId, {
          status: 'empty',
          postsCount: 0,
          completedAt: new Date()
        });

        await botService.sendMessage(
          user.telegramId,
          `📭 Дайджест "${digest.name}"\n\nЗа последний период новых постов не найдено.`
        );
        return;
      }

      // Get user settings for AI
      const settings = await storage.getUserSettings(user.id);
      
      // Generate summary
      const summaryResult = await summarizerService.generateSummary({
        posts: postsData,
        windowStart,
        windowEnd,
        timezone: user.timezone || 'UTC',
        model: settings?.openaiModel || undefined,
        maxTokens: settings?.maxTokens || undefined,
        temperature: settings?.temperature ? parseFloat(settings.temperature) : undefined,
        summaryLength: settings?.summaryLength as 'short' | 'medium' | 'long' | undefined
      });

      // Check if OpenAI returned empty content after fallback
      if (summaryResult.isEmpty) {
        // Update run with failed_openai_empty status and save metadata
        await storage.updateRun(runId, {
          status: 'failed_openai_empty',
          postsCount: totalPosts,
          tokensUsed: summaryResult.tokensUsed,
          summary: null, // Don't save empty summary
          errorMessage: `OpenAI returned empty content after fallback (${summaryResult.modelUsed} via ${summaryResult.endpointType})`,
          completedAt: new Date()
        });

        // Update digest last run time
        await storage.updateDigest(digestId, {
          lastRunAt: new Date()
        });

        // Record usage even for failed attempts
        await storage.recordUsage({
          userId: user.id,
          tokensIn: Math.floor(summaryResult.tokensUsed * 0.7), // Approximate input tokens
          tokensOut: Math.floor(summaryResult.tokensUsed * 0.3), // Approximate output tokens
          model: summaryResult.modelUsed || settings?.openaiModel || 'gpt-4o',
          periodDate: new Date()
        });

        // Notify user about the issue
        await botService.sendMessage(
          user.telegramId,
          `⚠️ Дайджест "${digest.name}"\n\nOpenAI не смог создать резюме для найденных постов. Попробуйте позже или обратитесь к администратору.`
        );

        logger.info('Digest failed due to empty OpenAI response', {
          digestId,
          runId,
          totalPosts,
          tokensUsed: summaryResult.tokensUsed,
          openaiRequestId: summaryResult.requestId,
          modelUsed: summaryResult.modelUsed
        });

        return;
      }

      // Update run with success
      await storage.updateRun(runId, {
        status: 'success',
        postsCount: totalPosts,
        tokensUsed: summaryResult.tokensUsed,
        summary: summaryResult.summary,
        completedAt: new Date()
      });

      // Update digest last run time
      await storage.updateDigest(digestId, {
        lastRunAt: new Date()
      });

      // Record usage
      await storage.recordUsage({
        userId: user.id,
        tokensIn: Math.floor(summaryResult.tokensUsed * 0.7), // Approximate input tokens
        tokensOut: Math.floor(summaryResult.tokensUsed * 0.3), // Approximate output tokens
        model: summaryResult.modelUsed || settings?.openaiModel || 'gpt-4o-mini',
        periodDate: new Date()
      });

      // Send summary to user
      const message = `📰 Дайджест "${digest.name}"\n\n${summaryResult.summary}`;
      
      logger.info('Attempting to send digest result to user', {
        digestId,
        runId,
        messageLength: message.length,
        digestName: digest.name,
        openaiRequestId: summaryResult.requestId,
        modelUsed: summaryResult.modelUsed,
        endpointType: summaryResult.endpointType
      });
      
      try {
        await botService.sendMessage(user.telegramId, message);
        
        logger.info('Digest result sent successfully to user', {
          digestId,
          runId,
          messageLength: message.length
        });
      } catch (sendError) {
        logger.error('Failed to send digest result to user', {
          digestId,
          runId,
          messageLength: message.length,
          error: sendError instanceof Error ? sendError.message : 'Unknown error'
        });
        throw sendError; // Re-throw to trigger error handling
      }

      logger.info('Digest executed successfully', {
        digestId,
        runId,
        totalPosts,
        tokensUsed: summaryResult.tokensUsed
      });

    } catch (error) {
      logger.error('Failed to execute digest', {
        digestId,
        runId,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      if (this.isDbConnectionError(error)) {
        logger.error('Database connection failure - skipping DB updates and user notification to prevent cascade', { digestId });
        return;
      }

      if (runId) {
        try {
          await storage.updateRun(runId, {
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            completedAt: new Date()
          });
        } catch (updateError) {
          logger.error('Failed to update run status', {
            runId,
            error: updateError instanceof Error ? updateError.message : 'Unknown error'
          });
        }
      }

      try {
        const digest = await storage.getDigest(digestId);
        const user = (digest && digest.userId) ? await storage.getUser(digest.userId) : null;
        
        if (user && digest) {
          await botService.sendMessage(
            user.telegramId,
            `❌ Ошибка при создании дайджеста "${digest.name}"\n\nПопробуйте ещё раз позже. Подробности сохранены в журнале оператора.`
          );
        }
      } catch (notificationError) {
        logger.error('Failed to send error notification', {
          error: notificationError instanceof Error ? notificationError.message : 'Unknown error'
        });
      }
    } finally {
      this.runningDigestIds.delete(digestId);
    }
  }

  async executeDigestManually(digestId: string): Promise<void> {
    logger.info('Manual digest execution requested', { digestId });
    await this.executeDigest(digestId);
  }

  private createCronExpression(
    localTime: string,
    frequency: 'daily' | 'weekly',
    weekday?: number,
    timezone?: string
  ): string {
    const [hours, minutes] = localTime.split(':').map(Number);

    if (frequency === 'daily') {
      return `${minutes} ${hours} * * *`;
    } else if (frequency === 'weekly' && typeof weekday === 'number') {
      return `${minutes} ${hours} * * ${weekday}`;
    }

    throw new Error('Invalid frequency or missing weekday for weekly digest');
  }

  async refreshSchedules(): Promise<void> {
    logger.info('Refreshing all schedules');
    
    // Clear all existing tasks
    for (const [digestId] of Array.from(this.tasks)) {
      await this.unscheduleDigest(digestId);
    }
    
    // Reschedule all active digests
    await this.scheduleAllActiveDigests();
  }

  getActiveTasksCount(): number {
    return this.tasks.size;
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down scheduler');
    
    for (const [digestId] of Array.from(this.tasks)) {
      await this.unscheduleDigest(digestId);
    }
    
    this.isInitialized = false;
  }
}

export const schedulerService = new SchedulerService();
