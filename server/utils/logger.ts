import winston from "winston";
import { randomUUID } from "node:crypto";
import { isPublishedApp } from "./env.js";

interface PerformanceMetric {
  operation: string;
  startTime: number;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /(authorization|cookie|password|secret|session|token|api.?key)/i;
const SECRET_PATTERNS = [
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/g,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:[^\s@]+@/gi,
];

function redactString(value: string): string {
  return SECRET_PATTERNS.reduce(
    (sanitized, pattern) => sanitized.replace(pattern, "[REDACTED]"),
    value,
  );
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

class EnhancedLogger {
  private readonly winston: winston.Logger;
  private readonly performanceMetrics = new Map<string, PerformanceMetric>();

  constructor() {
    this.winston = winston.createLogger({
      level: process.env.LOG_LEVEL || (isPublishedApp() ? "info" : "debug"),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json(),
      ),
      defaultMeta: { service: "morningfeed-bot" },
      transports: [new winston.transports.Console()],
    });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.winston.info(redactString(message), sanitize(meta || {}) as object);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.winston.error(redactString(message), sanitize(meta || {}) as object);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.winston.warn(redactString(message), sanitize(meta || {}) as object);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.winston.debug(redactString(message), sanitize(meta || {}) as object);
  }

  digestStart(digestId: string, userId: string, metadata?: Record<string, unknown>): string {
    const correlationId = randomUUID();
    this.info("Digest execution started", { digestId, userId, correlationId, ...metadata });
    return correlationId;
  }

  digestProgress(correlationId: string, step: string, metadata?: Record<string, unknown>): void {
    this.info("Digest execution progress", { correlationId, step, ...metadata });
  }

  digestComplete(correlationId: string, digestId: string, metrics?: Record<string, unknown>): void {
    this.info("Digest execution completed", { correlationId, digestId, ...metrics });
  }

  digestError(correlationId: string, error: Error, context?: Record<string, unknown>): void {
    this.error("Digest execution failed", { correlationId, error: error.message, ...context });
  }

  startTimer(operation: string, metadata?: Record<string, unknown>): string {
    const timerId = randomUUID();
    this.performanceMetrics.set(timerId, { operation, startTime: Date.now(), metadata });
    return timerId;
  }

  endTimer(timerId: string, additionalMeta?: Record<string, unknown>): number | null {
    const metric = this.performanceMetrics.get(timerId);
    if (!metric) return null;
    const duration = Date.now() - metric.startTime;
    this.performanceMetrics.delete(timerId);
    this.info("Performance metric", {
      operation: metric.operation,
      duration,
      ...metric.metadata,
      ...additionalMeta,
    });
    return duration;
  }

  channelIngestion(channel: string, status: "started" | "completed" | "failed", metadata?: Record<string, unknown>): void {
    this.info("Channel ingestion", { channel, status, ...metadata });
  }
}

export const logger = new EnhancedLogger();
export type { PerformanceMetric };
