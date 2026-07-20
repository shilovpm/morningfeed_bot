import cron from 'node-cron';
import { storage } from '../storage.js';
import { botService } from '../telegram/bot.js';
import { logger } from '../utils/logger.js';

interface WatchdogConfig {
  checkIntervalMinutes: number;
  runTimeoutMinutes: number;
  enabled: boolean;
}

class WatchdogService {
  private task: any = null;
  private config: WatchdogConfig = {
    checkIntervalMinutes: 5,
    runTimeoutMinutes: 10,
    enabled: false
  };

  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Watchdog service disabled');
      return;
    }

    // Run immediately on startup
    await this.checkStalledRuns();

    // Schedule periodic checks
    this.task = cron.schedule(`*/${this.config.checkIntervalMinutes} * * * *`, async () => {
      await this.checkStalledRuns();
    });

    logger.info('Watchdog service initialized', {
      checkInterval: `${this.config.checkIntervalMinutes} minutes`,
      runTimeout: `${this.config.runTimeoutMinutes} minutes`
    });
  }

  async checkStalledRuns(): Promise<void> {
    try {
      const timeoutThreshold = new Date();
      timeoutThreshold.setMinutes(timeoutThreshold.getMinutes() - this.config.runTimeoutMinutes);

      // Find runs that are stuck in 'running' status for too long
      const allRuns = await storage.getRunsInPeriod(
        new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        new Date()
      );

      const stalledRuns = allRuns.filter(run => 
        run.status === 'running' && 
        run.createdAt && 
        run.createdAt < timeoutThreshold
      );

      if (stalledRuns.length === 0) {
        logger.debug('No stalled runs found');
        return;
      }

      logger.warn('Found stalled runs', { 
        count: stalledRuns.length,
        runIds: stalledRuns.map(r => r.id)
      });

      for (const run of stalledRuns) {
        await this.handleStalledRun(run);
      }

    } catch (error) {
      logger.error('Watchdog check failed', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async handleStalledRun(run: any): Promise<void> {
    try {
      if (!run.createdAt) {
        logger.warn('Run has no createdAt timestamp, skipping', { runId: run.id });
        return;
      }

      const runtimeMinutes = Math.floor((Date.now() - run.createdAt.getTime()) / 1000 / 60);

      logger.info('Handling stalled run', {
        runId: run.id,
        digestId: run.digestId,
        runtimeMinutes,
        createdAt: run.createdAt.toISOString()
      });

      // Mark run as failed due to timeout
      await storage.updateRun(run.id, {
        status: 'failed_timeout',
        errorMessage: `Run timed out after ${runtimeMinutes} minutes. Possible causes: database connection lost during OpenAI request, application crash, or network issues.`,
        completedAt: new Date()
      });

      // Try to notify user
      const digest = await storage.getDigest(run.digestId);
      if (digest && digest.userId) {
        const user = await storage.getUser(digest.userId);
        
        if (user) {
          const message = `⏱ Дайджест "${digest.name}" был прерван\n\n` +
            `Время выполнения превысило ${this.config.runTimeoutMinutes} минут. ` +
            `Попробуйте запустить снова командой /digest_run ${digest.name}`;

          try {
            await botService.sendMessage(user.telegramId, message);
            
            logger.info('Stalled run notification sent', {
              runId: run.id,
              userId: user.id
            });
          } catch (sendError) {
            logger.error('Failed to send stalled run notification', {
              runId: run.id,
              userId: user.id,
              error: sendError instanceof Error ? sendError.message : 'Unknown error'
            });
          }
        }
      }

      logger.info('Stalled run handled successfully', {
        runId: run.id,
        digestId: run.digestId
      });

    } catch (error) {
      logger.error('Failed to handle stalled run', {
        runId: run.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.task) {
      this.task.stop();
      this.task.destroy();
      logger.info('Watchdog service shut down');
    }
  }

  // Manual check endpoint
  async runCheck(): Promise<number> {
    await this.checkStalledRuns();
    const allRuns = await storage.getRunsInPeriod(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      new Date()
    );
    return allRuns.filter(r => r.status === 'running').length;
  }
}

export const watchdogService = new WatchdogService();
