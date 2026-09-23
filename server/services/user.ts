import { storage } from '../storage.js';
import { schedulerService } from './scheduler.js';
import { logger } from '../utils/logger.js';
import type { User, InsertUser, Digest, InsertDigest, Channel } from '@shared/schema.js';
import { isTelegramAdmin } from '../utils/access-control.js';

class UserService {
  async getOrCreateUser(telegramUser: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  }): Promise<User> {
    let user = await storage.getUserByTelegramId(String(telegramUser.id));
    const configuredAdmin = isTelegramAdmin(telegramUser.id);
    
    if (!user) {
      const newUser: InsertUser = {
        telegramId: String(telegramUser.id),
        username: telegramUser.username,
        firstName: telegramUser.first_name,
        lastName: telegramUser.last_name,
        languageCode: telegramUser.language_code || 'ru',
        timezone: 'UTC',
        plan: 'free',
        isAdmin: configuredAdmin
      };
      
      user = await storage.createUser(newUser);
      
      // Create default user settings
      await storage.createUserSettings({
        userId: user.id,
        openaiModel: 'gpt-6-luna',
        summaryLength: 'medium',
        temperature: '0.3',
        maxTokens: 4000,
        emailNotifications: true
      });
      
      logger.info('New user created', {
        userId: user.id,
        isAdmin: user.isAdmin
      });
    } else if (user.isAdmin !== configuredAdmin) {
      user = await storage.updateUser(user.id, { isAdmin: configuredAdmin });
    }
    
    return user;
  }

  async updateUserTimezone(userId: string, timezone: string): Promise<void> {
    await storage.updateUser(userId, { timezone });
    
    // Refresh schedules for user's digests since timezone changed
    const userDigests = await storage.getUserDigests(userId);
    for (const digest of userDigests) {
      if (digest.isActive) {
        await schedulerService.scheduleDigest(digest.id);
      }
    }
    
    logger.info('User timezone updated', { userId, timezone, digestsRescheduled: userDigests.length });
  }

  async createDigest(userId: string, digestData: {
    name: string;
    frequency: 'daily' | 'weekly';
    localTime: string;
    weekday?: number;
  }): Promise<Digest> {
    const { name, frequency, localTime, weekday } = digestData;
    
    // Check if user already has a digest with this name
    const existingDigests = await storage.getUserDigests(userId);
    const nameExists = existingDigests.some(d => d.name.toLowerCase() === name.toLowerCase());
    
    if (nameExists) {
      throw new Error(`Дайджест с именем "${name}" уже существует`);
    }

    // Check plan limits
    const user = await storage.getUser(userId);
    if (user?.plan === 'free' && existingDigests.length >= 5) {
      throw new Error('На бесплатном плане можно создать максимум 5 дайджестов. Обновитесь до Pro для снятия ограничений.');
    }

    const digestInsert: InsertDigest = {
      userId,
      name,
      frequency,
      localTime,
      weekday: frequency === 'weekly' ? (weekday || 1) : null,
      isActive: true
    };

    const digest = await storage.createDigest(digestInsert);
    
    // Schedule the digest
    await schedulerService.scheduleDigest(digest.id);
    
    logger.info('Digest created', {
      digestId: digest.id,
      userId,
      name,
      frequency,
      localTime
    });
    
    return digest;
  }

  async addChannelToDigest(digestId: string, channelUsername: string): Promise<void> {
    // Validate channel exists and is accessible
    const validation = await this.validateAndCreateChannel(channelUsername);
    
    if (!validation.isValid || !validation.channel) {
      throw new Error(validation.error || 'Invalid channel');
    }

    // Check if channel is already in digest
    const existingChannels = await storage.getDigestChannels(digestId);
    const channelExists = existingChannels.some(c => c.username === validation.channel!.username);
    
    if (channelExists) {
      throw new Error(`Канал ${channelUsername} уже добавлен в этот дайджест`);
    }

    await storage.addChannelToDigest(digestId, validation.channel.id);
    
    logger.info('Channel added to digest', {
      digestId,
      channelId: validation.channel.id,
      channelUsername: validation.channel.username
    });
  }

  async removeChannelFromDigest(digestId: string, channelUsername: string): Promise<void> {
    const channel = await storage.getChannelByUsername(channelUsername);
    if (!channel) {
      throw new Error(`Канал ${channelUsername} не найден`);
    }

    await storage.removeChannelFromDigest(digestId, channel.id);
    
    logger.info('Channel removed from digest', {
      digestId,
      channelId: channel.id,
      channelUsername
    });
  }

  private normalizeChannelUsername(input: string): string | null {
    let username = input.trim();
    username = username.replace(/^https?:\/\//i, '');
    username = username.replace(/^(telegram\.me|telegram\.dog|t\.me)\//i, '');
    username = username.replace(/^s\//i, '');
    username = username.replace(/[?#].*$/, '');
    username = username.replace(/\/.*$/, '');
    username = username.replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;
    return `@${username}`;
  }

  private async validateAndCreateChannel(username: string): Promise<{
    isValid: boolean;
    channel?: Channel;
    error?: string;
  }> {
    const cleanUsername = this.normalizeChannelUsername(username);
    if (!cleanUsername) {
      return {
        isValid: false,
        error: 'Use a public Telegram username containing 5-32 letters, digits, or underscores'
      };
    }
    
    // Check if channel already exists in our database
    let channel = await storage.getChannelByUsername(cleanUsername);
    
    if (channel) {
      return { isValid: true, channel };
    }

    // Validate with Telegram
    try {
      const { ingestionService } = await import('./ingestion.js');
      const validation = await ingestionService.validateChannel(cleanUsername);
      
      if (!validation.isValid || !validation.isAccessible) {
        return { 
          isValid: false, 
          error: validation.error || 'Channel is not accessible' 
        };
      }

      // Create channel in our database
      channel = await storage.createChannel({
        username: cleanUsername,
        title: validation.title,
        description: validation.description,
        isPrivate: false,
        isActive: true
      });

      return { isValid: true, channel };

    } catch (error) {
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Validation failed'
      };
    }
  }

  async getUserStats(userId: string): Promise<{
    digestsCount: number;
    channelsCount: number;
    monthlyTokens: number;
    monthlyLimit: number;
  }> {
    const user = await storage.getUser(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const digests = await storage.getUserDigests(userId);
    const allChannels = new Set<string>();
    
    for (const digest of digests) {
      const channels = await storage.getDigestChannels(digest.id);
      channels.forEach(c => allChannels.add(c.id));
    }

    // Get current month usage
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthlyUsage = await storage.getMonthlyUsage(userId, monthStart);

    const monthlyLimit = user.plan === 'free' ? 100000 : 1000000; // Free: 100K, Pro: 1M

    return {
      digestsCount: digests.length,
      channelsCount: allChannels.size,
      monthlyTokens: monthlyUsage,
      monthlyLimit
    };
  }

  async deleteUser(userId: string): Promise<void> {
    const user = await storage.getUser(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Unschedule all user's digests
    const digests = await storage.getUserDigests(userId);
    for (const digest of digests) {
      await schedulerService.unscheduleDigest(digest.id);
    }

    // Delete user and all related data (cascades automatically)
    await storage.deleteUser(userId);
    
    logger.info('User deleted', { userId });
  }
}

export const userService = new UserService();
