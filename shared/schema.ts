import type {
  Channel,
  Digest,
  DigestChannel,
  Run,
  Usage,
  User,
  UserSettings,
} from "@prisma/client";

export type { Channel, Digest, DigestChannel, Run, Usage, User, UserSettings };

export type InsertUser = Pick<User, "telegramId"> &
  Partial<
    Pick<
      User,
      | "username"
      | "firstName"
      | "lastName"
      | "languageCode"
      | "timezone"
      | "plan"
      | "isAdmin"
    >
  >;

export type InsertDigest = Pick<
  Digest,
  "userId" | "name" | "frequency" | "localTime"
> &
  Partial<Pick<Digest, "weekday" | "isActive">>;

export type InsertChannel = Pick<Channel, "username"> &
  Partial<
    Pick<Channel, "title" | "description" | "isPrivate" | "isActive">
  >;

export type InsertUserSettings = Pick<UserSettings, "userId"> &
  Partial<
    Pick<
      UserSettings,
      | "openaiModel"
      | "summaryLength"
      | "temperature"
      | "maxTokens"
      | "emailNotifications"
    >
  >;

export type StatsResponse = {
  totalUsers: number;
  activeDigests: number;
  monitoredChannels: number;
  postsProcessed: number;
  tokensUsed: number;
  dailyRuns: number;
  errorRate: number;
};
