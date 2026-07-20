import { prisma } from './database.js';
import type { 
  User, 
  InsertUser, 
  Digest, 
  InsertDigest, 
  Channel, 
  InsertChannel, 
  DigestChannel,
  Run,
  UserSettings,
  InsertUserSettings,
  Usage,
  StatsResponse
} from '@shared/schema.js';

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | null>;
  getUserByTelegramId(telegramId: string): Promise<User | null>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, data: Partial<User>): Promise<User>;
  deleteUser(id: string): Promise<void>;

  // Digests
  getDigest(id: string): Promise<Digest | null>;
  getUserDigests(userId: string): Promise<Digest[]>;
  getActiveDigests(): Promise<Digest[]>;
  createDigest(digest: InsertDigest): Promise<Digest>;
  updateDigest(id: string, data: Partial<Digest>): Promise<Digest>;
  deleteDigest(id: string): Promise<void>;

  // Channels
  getChannel(id: string): Promise<Channel | null>;
  getChannelByUsername(username: string): Promise<Channel | null>;
  getAllChannels(): Promise<Channel[]>;
  getDigestChannels(digestId: string): Promise<Channel[]>;
  createChannel(channel: InsertChannel): Promise<Channel>;
  updateChannel(id: string, data: Partial<Channel>): Promise<Channel>;
  addChannelToDigest(digestId: string, channelId: string): Promise<void>;
  removeChannelFromDigest(digestId: string, channelId: string): Promise<void>;
  
  // Web scraping cursor tracking
  updateChannelCursor(channelId: string, messageId: string, etag?: string, lastFetchedAt?: Date): Promise<void>;
  markChannelStatus(channelId: string, status: 'active' | 'degraded' | 'unavailable', retryAfter?: Date): Promise<void>;
  getActiveChannelsForScraping(): Promise<Channel[]>;
  getChannelsByStatus(status: string): Promise<Channel[]>;
  
  // Robust pagination state (before-based pagination)
  updatePaginationState(channelId: string, params: {
    lowestMessageId?: string;
    lastSeenMessageId?: string;
    lastDeepFetchAt?: Date;
  }): Promise<void>;
  incrementPaginationFailures(channelId: string): Promise<void>;
  resetPaginationFailures(channelId: string): Promise<void>;
  markChannelAsHighVolume(channelId: string, isHighVolume: boolean): Promise<void>;
  getHighVolumeChannels(): Promise<Channel[]>;

  // Runs
  createRun(run: Omit<Run, 'id' | 'createdAt' | 'completedAt'>): Promise<string>;
  updateRun(id: string, data: Partial<Run>): Promise<Run>;
  getRunsInPeriod(startDate: Date, endDate: Date): Promise<Run[]>;
  getRecentErrors(limit: number): Promise<Run[]>;

  // User Settings
  getUserSettings(userId: string): Promise<UserSettings | null>;
  createUserSettings(settings: InsertUserSettings): Promise<UserSettings>;
  updateUserSettings(userId: string, data: Partial<UserSettings>): Promise<UserSettings>;

  // Usage
  recordUsage(usage: Omit<Usage, 'id' | 'createdAt'>): Promise<void>;
  getMonthlyUsage(userId: string, monthStart: Date): Promise<number>;

  // System Stats
  getSystemStats(): Promise<StatsResponse>;
}

// Helper to convert null values to undefined (Prisma expects undefined for nullable fields)
function removeNulls<T extends Record<string, any>>(obj: T): any {
  const result: any = {};
  for (const key in obj) {
    result[key] = obj[key] === null ? undefined : obj[key];
  }
  return result;
}

export class PrismaStorage implements IStorage {
  async getUser(id: string): Promise<User | null> {
    return await prisma.user.findUnique({
      where: { id }
    });
  }

  async getUserByTelegramId(telegramId: string): Promise<User | null> {
    return await prisma.user.findUnique({
      where: { telegramId }
    });
  }

  async createUser(user: InsertUser): Promise<User> {
    return await prisma.user.create({
      data: removeNulls(user)
    });
  }

  async updateUser(id: string, data: Partial<User>): Promise<User> {
    return await prisma.user.update({
      where: { id },
      data: removeNulls(data)
    });
  }

  async deleteUser(id: string): Promise<void> {
    await prisma.user.delete({
      where: { id }
    });
  }

  async getDigest(id: string): Promise<Digest | null> {
    return await prisma.digest.findUnique({
      where: { id }
    });
  }

  async getUserDigests(userId: string): Promise<Digest[]> {
    return await prisma.digest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getActiveDigests(): Promise<Digest[]> {
    return await prisma.digest.findMany({
      where: { isActive: true },
      include: { user: true }
    });
  }

  async createDigest(digest: InsertDigest): Promise<Digest> {
    return await prisma.digest.create({
      data: removeNulls(digest)
    });
  }

  async updateDigest(id: string, data: Partial<Digest>): Promise<Digest> {
    return await prisma.digest.update({
      where: { id },
      data: removeNulls({
        ...data,
        updatedAt: new Date()
      })
    });
  }

  async deleteDigest(id: string): Promise<void> {
    await prisma.digest.delete({
      where: { id }
    });
  }

  async getChannel(id: string): Promise<Channel | null> {
    return await prisma.channel.findUnique({
      where: { id }
    });
  }

  async getChannelByUsername(username: string): Promise<Channel | null> {
    return await prisma.channel.findUnique({
      where: { username }
    });
  }

  async getAllChannels(): Promise<Channel[]> {
    return await prisma.channel.findMany({
      orderBy: { createdAt: 'desc' }
    });
  }

  async getDigestChannels(digestId: string): Promise<Channel[]> {
    const digestChannels = await prisma.digestChannel.findMany({
      where: { digestId },
      include: { channel: true }
    });

    return digestChannels.map(dc => dc.channel);
  }

  async createChannel(channel: InsertChannel): Promise<Channel> {
    return await prisma.channel.create({
      data: removeNulls(channel)
    });
  }

  async updateChannel(id: string, data: Partial<Channel>): Promise<Channel> {
    return await prisma.channel.update({
      where: { id },
      data: removeNulls(data)
    });
  }

  async addChannelToDigest(digestId: string, channelId: string): Promise<void> {
    await prisma.digestChannel.create({
      data: {
        digestId,
        channelId
      }
    });
  }

  async removeChannelFromDigest(digestId: string, channelId: string): Promise<void> {
    await prisma.digestChannel.deleteMany({
      where: {
        digestId,
        channelId
      }
    });
  }

  async createRun(run: Omit<Run, 'id' | 'createdAt' | 'completedAt'>): Promise<string> {
    const created = await prisma.run.create({
      data: removeNulls(run) as any
    });
    return created.id;
  }

  async updateRun(id: string, data: Partial<Run>): Promise<Run> {
    return await prisma.run.update({
      where: { id },
      data: removeNulls(data)
    });
  }

  async getRunsInPeriod(startDate: Date, endDate: Date): Promise<Run[]> {
    return await prisma.run.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getRecentErrors(limit: number): Promise<Run[]> {
    return await prisma.run.findMany({
      where: { status: 'error' },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  async getUserSettings(userId: string): Promise<UserSettings | null> {
    return await prisma.userSettings.findUnique({
      where: { userId }
    });
  }

  async createUserSettings(settings: InsertUserSettings): Promise<UserSettings> {
    return await prisma.userSettings.create({
      data: removeNulls(settings)
    });
  }

  async updateUserSettings(userId: string, data: Partial<UserSettings>): Promise<UserSettings> {
    return await prisma.userSettings.upsert({
      where: { userId },
      update: removeNulls({
        ...data,
        updatedAt: new Date()
      }),
      create: removeNulls({
        userId,
        ...data
      })
    });
  }

  async recordUsage(usage: Omit<Usage, 'id' | 'createdAt'>): Promise<void> {
    await prisma.usage.create({
      data: removeNulls(usage) as any
    });
  }

  async getMonthlyUsage(userId: string, monthStart: Date): Promise<number> {
    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);

    const result = await prisma.usage.aggregate({
      where: {
        userId,
        createdAt: {
          gte: monthStart,
          lt: monthEnd
        }
      },
      _sum: {
        tokensIn: true,
        tokensOut: true
      }
    });

    return (result._sum.tokensIn || 0) + (result._sum.tokensOut || 0);
  }

  async getSystemStats(): Promise<StatsResponse> {
    const [
      totalUsers,
      activeDigests,
      monitoredChannels,
      todayRuns,
      todaySuccessRuns,
      monthlyUsage
    ] = await Promise.all([
      prisma.user.count(),
      prisma.digest.count({ where: { isActive: true } }),
      prisma.channel.count({ where: { isActive: true } }),
      prisma.run.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      prisma.run.count({
        where: {
          status: 'success',
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      prisma.usage.aggregate({
        where: {
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          }
        },
        _sum: {
          tokensIn: true,
          tokensOut: true
        }
      })
    ]);

    const postsProcessed = await prisma.run.aggregate({
      _sum: {
        postsCount: true
      }
    });

    const errorRate = todayRuns > 0 ? ((todayRuns - todaySuccessRuns) / todayRuns) * 100 : 0;

    return {
      totalUsers,
      activeDigests,
      monitoredChannels,
      postsProcessed: postsProcessed._sum.postsCount || 0,
      tokensUsed: (monthlyUsage._sum.tokensIn || 0) + (monthlyUsage._sum.tokensOut || 0),
      dailyRuns: todayRuns,
      errorRate
    };
  }

  // Web scraping cursor tracking methods
  async updateChannelCursor(
    channelId: string, 
    messageId: string, 
    etag?: string, 
    lastFetchedAt?: Date
  ): Promise<void> {
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        lastMessageId: messageId,
        etag: etag || null,
        lastFetchedAt: lastFetchedAt || new Date(),
        lastCheckedAt: new Date()
      }
    });
  }

  async markChannelStatus(
    channelId: string, 
    status: 'active' | 'degraded' | 'unavailable', 
    retryAfter?: Date
  ): Promise<void> {
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        fetchStatus: status,
        retryAfter: retryAfter || null,
        lastCheckedAt: new Date()
      }
    });
  }

  async getActiveChannelsForScraping(): Promise<Channel[]> {
    const now = new Date();
    
    return await prisma.channel.findMany({
      where: {
        isActive: true,
        OR: [
          // Active channels (always ready)
          { fetchStatus: 'active' },
          // Degraded channels ready for retry
          {
            fetchStatus: 'degraded',
            retryAfter: {
              lte: now
            }
          }
        ]
      },
      orderBy: { lastCheckedAt: 'asc' } // Prioritize least recently checked
    });
  }

  async getChannelsByStatus(status: string): Promise<Channel[]> {
    return await prisma.channel.findMany({
      where: { fetchStatus: status },
      orderBy: { lastCheckedAt: 'desc' }
    });
  }

  // Robust pagination state methods
  async updatePaginationState(
    channelId: string, 
    params: {
      lowestMessageId?: string;
      lastSeenMessageId?: string;
      lastDeepFetchAt?: Date;
    }
  ): Promise<void> {
    await prisma.channel.update({
      where: { id: channelId },
      data: removeNulls({
        lowestMessageId: params.lowestMessageId,
        lastSeenMessageId: params.lastSeenMessageId,
        lastDeepFetchAt: params.lastDeepFetchAt,
        lastCheckedAt: new Date()
      })
    });
  }

  async incrementPaginationFailures(channelId: string): Promise<void> {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { paginationFailureCount: true }
    });
    
    if (channel) {
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          paginationFailureCount: (channel.paginationFailureCount || 0) + 1
        }
      });
    }
  }

  async resetPaginationFailures(channelId: string): Promise<void> {
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        paginationFailureCount: 0
      }
    });
  }

  async markChannelAsHighVolume(channelId: string, isHighVolume: boolean): Promise<void> {
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        isHighVolume
      }
    });
  }

  async getHighVolumeChannels(): Promise<Channel[]> {
    return await prisma.channel.findMany({
      where: { 
        isHighVolume: true,
        isActive: true 
      },
      orderBy: { lastCheckedAt: 'asc' }
    });
  }
}

export const storage = new PrismaStorage();
