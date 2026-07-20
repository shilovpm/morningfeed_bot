import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

interface TelegramPost {
  id: number;
  dt: string;
  text: string;
  url: string;
}

interface ScraperResult {
  posts: TelegramPost[];
  status: 'ok' | 'error';
  error?: string;
  etag?: string;
  lastModified?: string;
  wasNotModified?: boolean;
  // Pagination metadata for robust pagination
  minId?: number;
  maxId?: number;
  pagesFetched?: number;
  steppingUsed?: boolean;
}

interface RequestOptions {
  lastMessageId?: string;
  etag?: string;
  lastModified?: string;
  // Pagination strategy
  useBefore?: boolean; // Use ?before= instead of ?after=
  steppingOffsets?: number[]; // Try before=cursor-1, -5, -10, etc on "No posts"
}

// Global rate limiter
class RateLimiter {
  private lastRequestTime = 0;
  private requestQueue: Promise<void> = Promise.resolve();
  
  // 6-10 req/min = ~6000-10000ms between requests
  private minDelay = 6000;
  private maxDelay = 10000;
  
  async waitForSlot(): Promise<void> {
    this.requestQueue = this.requestQueue.then(async () => {
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      
      // Calculate delay with jitter (200-1200ms additional random delay)
      const baseDelay = Math.floor(Math.random() * (this.maxDelay - this.minDelay)) + this.minDelay;
      const jitter = Math.floor(Math.random() * 1000) + 200;
      const totalDelay = baseDelay + jitter;
      
      if (timeSinceLastRequest < totalDelay) {
        const waitTime = totalDelay - timeSinceLastRequest;
        logger.debug('Rate limiter: waiting', { waitTime });
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      this.lastRequestTime = Date.now();
    });
    
    return this.requestQueue;
  }
}

const rateLimiter = new RateLimiter();
const CHANNEL_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * Retry logic with exponential backoff for 429 errors
 */
async function fetchWithRetry(
  url: string,
  options: RequestOptions,
  retries = 3,
  startTime: number
): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    let lastHttpStatus: number | null = null;
    
    try {
      // Wait for rate limiter
      await rateLimiter.waitForSlot();
      
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
      };
      
      // Add conditional GET headers for caching
      if (options.etag) {
        headers['If-None-Match'] = options.etag;
      }
      if (options.lastModified) {
        headers['If-Modified-Since'] = options.lastModified;
      }
      
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30000), // 30s timeout
      });
      
      lastHttpStatus = response.status;
      
      // Handle 304 Not Modified
      if (response.status === 304) {
        logger.info('Cache hit: 304 Not Modified', { url });
        return response;
      }
      
      // Success
      if (response.ok) {
        return response;
      }
      
      // Handle 429 Rate Limit
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
        const requestedWait = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : Math.pow(2, attempt) * 30000;
        const waitTime = Math.min(Math.max(requestedWait, 0), MAX_RETRY_AFTER_MS);
        
        logger.warn('Rate limited (429), waiting', { 
          attempt: attempt + 1, 
          waitTime,
          retryAfter 
        });
        
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }
        
        // Last retry - record error metric and throw
        const latency = Date.now() - startTime;
        recordMetric(429, latency, false);
        throw new Error(`HTTP 429: Rate limit exceeded`);
      }
      
      // Handle 403 Forbidden
      if (response.status === 403) {
        logger.warn('Forbidden (403) - possible IP block or privacy settings', { url });
        const latency = Date.now() - startTime;
        recordMetric(403, latency, false);
        throw new Error('Channel unavailable (403 Forbidden)');
      }
      
      // Other HTTP errors
      const latency = Date.now() - startTime;
      recordMetric(response.status, latency, false);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      
    } catch (error) {
      // If it's HTTP error, it's already recorded and thrown
      if (lastHttpStatus && lastHttpStatus >= 400) {
        throw error;
      }
      
      // Network errors: retry with increasing delay
      if (attempt === retries - 1) {
        // Last retry for network error - record generic error
        const latency = Date.now() - startTime;
        recordMetric(0, latency, false); // 0 = network error
        throw error;
      }
      
      const delay = 2000 * (attempt + 1);
      logger.debug('Network error, retrying', { 
        attempt: attempt + 1, 
        delay,
        error: error instanceof Error ? error.message : 'Unknown' 
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw new Error('Max retries exceeded');
}

/**
 * Parse HTML using stable selectors (not fragile CSS classes)
 */
function parseChannelHTML(html: string, username: string): TelegramPost[] {
  const $ = cheerio.load(html);
  const posts: TelegramPost[] = [];
  
  // Try primary selector
  let $messages = $('.tgme_widget_message');
  
  // Fallback selectors if primary fails
  if ($messages.length === 0) {
    logger.warn('Primary selector failed, trying fallbacks', { username });
    $messages = $('.message, article[data-post], [data-post]');
  }
  
  if ($messages.length === 0) {
    logger.warn('No messages found with any selector', { username });
    return [];
  }
  
  $messages.each((i, el) => {
    const $msg = $(el);
    
    // Extract message ID from stable attributes
    const dataPost = $msg.attr('data-post');
    let messageId = 0;
    
    if (dataPost) {
      const parts = dataPost.split('/');
      messageId = parseInt(parts[parts.length - 1]) || 0;
    } else {
      // Fallback: extract from link href
      const link = $msg.find('a.tgme_widget_message_date, a[href*="/"]').attr('href');
      if (link) {
        const match = link.match(/\/(\d+)$/);
        if (match) messageId = parseInt(match[1]);
      }
    }
    
    // Extract text
    const text = $msg.find('.tgme_widget_message_text, .message-text, [class*="text"]')
      .first()
      .text()
      .trim();
    
    // Extract date from time element
    const dateStr = $msg.find('time').attr('datetime');
    
    // Extract URL - use stable pattern
    let url = $msg.find('a.tgme_widget_message_date').attr('href');
    if (!url && messageId) {
      url = `https://t.me/${username}/${messageId}`;
    }
    
    if (dateStr && messageId > 0) {
      posts.push({
        id: messageId,
        dt: new Date(dateStr).toISOString(),
        text,
        url: url || `https://t.me/${username}/${messageId}`
      });
    }
  });
  
  // Deduplicate by message ID
  const uniquePosts = Array.from(
    new Map(posts.map(post => [post.id, post])).values()
  );
  
  return uniquePosts;
}

/**
 * Fetch posts from public Telegram channel using web scraping
 */
export async function fetchPublicChannel(
  username: string,
  startDate: Date,
  endDate: Date,
  options: RequestOptions = {}
): Promise<ScraperResult> {
  const startTime = Date.now();
  
  try {
    const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
    if (!CHANNEL_USERNAME_PATTERN.test(cleanUsername)) {
      throw new Error('Invalid Telegram channel username');
    }

    if (options.lastMessageId && !/^\d+$/.test(options.lastMessageId)) {
      throw new Error('Invalid Telegram pagination cursor');
    }
    
    // Build URL with cursor pagination
    // Prefer ?before= over ?after= (more reliable per recommendations)
    let url = `https://t.me/s/${cleanUsername}`;
    if (options.lastMessageId) {
      if (options.useBefore) {
        url += `?before=${options.lastMessageId}`;
        logger.debug('Using before-based pagination', { 
          username: cleanUsername, 
          before: options.lastMessageId 
        });
      } else {
        url += `?after=${options.lastMessageId}`;
        logger.debug('Using after-based pagination', { 
          username: cleanUsername, 
          after: options.lastMessageId 
        });
      }
    }
    
    let response: Response;
    try {
      response = await fetchWithRetry(url, options, 3, startTime);
    } catch (primaryError) {
      // If t.me failed with a network error (DNS/connectivity), try telegram.me as fallback
      const isFetchFailed = primaryError instanceof Error && primaryError.message === 'fetch failed';
      const isNetworkError = primaryError instanceof Error && !primaryError.message.startsWith('HTTP') && !primaryError.message.includes('Max retries');
      if ((isFetchFailed || isNetworkError) && url.includes('t.me')) {
        const fallbackUrl = url.replace('https://t.me/', 'https://telegram.me/');
        logger.warn('t.me unreachable, retrying with telegram.me fallback', { url, fallbackUrl });
        response = await fetchWithRetry(fallbackUrl, options, 2, startTime);
      } else {
        throw primaryError;
      }
    }
    const latency = Date.now() - startTime;
    
    // Handle 304 Not Modified
    if (response.status === 304) {
      recordMetric(304, latency, true);
      return {
        posts: [],
        status: 'ok',
        wasNotModified: true,
        etag: options.etag,
        lastModified: options.lastModified
      };
    }
    
    recordMetric(response.status, latency, false);
    
    const html = await response.text();
    
    // Extract caching headers
    const etag = response.headers.get('ETag') || undefined;
    const lastModified = response.headers.get('Last-Modified') || undefined;
    
    // Parse HTML
    const allPosts = parseChannelHTML(html, cleanUsername);
    
    // Filter by date range
    const filteredPosts = allPosts.filter(post => {
      const postDate = new Date(post.dt);
      return postDate >= startDate && postDate <= endDate;
    });
    
    // Sort by date descending
    filteredPosts.sort((a, b) => new Date(b.dt).getTime() - new Date(a.dt).getTime());
    
    // Calculate metadata for pagination
    const minId = allPosts.length > 0 ? Math.min(...allPosts.map(p => p.id)) : undefined;
    const maxId = allPosts.length > 0 ? Math.max(...allPosts.map(p => p.id)) : undefined;
    
    logger.info('Channel scraped successfully', {
      channel: cleanUsername,
      totalParsed: allPosts.length,
      inDateRange: filteredPosts.length,
      minId,
      maxId,
      hasETag: !!etag,
      hasLastModified: !!lastModified
    });
    
    // Detect possible HTML structure change
    if (allPosts.length === 0) {
      logger.warn('ALERT: No posts parsed - possible HTML structure change!', {
        channel: cleanUsername,
        url
      });
    }
    
    return {
      posts: filteredPosts,
      status: 'ok',
      etag,
      lastModified,
      wasNotModified: false,
      minId,
      maxId,
      pagesFetched: 1
    };
    
  } catch (error) {
    // Don't record metric here - already recorded by fetchWithRetry or recordMetric
    // Recording 500 here would duplicate error count for HTTP errors (403, 429, etc.)
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    logger.error('Web scraping failed', {
      channel: username,
      error: errorMessage
    });
    
    return {
      posts: [],
      status: 'error',
      error: errorMessage
    };
  }
}

/**
 * Metrics for monitoring
 */
interface ScraperMetrics {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  cacheHits: number;
  totalLatency: number;
  requestsByStatus: Record<number, number>;
}

const metrics: ScraperMetrics = {
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  cacheHits: 0,
  totalLatency: 0,
  requestsByStatus: {}
};

function recordMetric(status: number, latency: number, wasCacheHit: boolean = false) {
  metrics.totalRequests++;
  metrics.totalLatency += latency;
  
  // Treat as success: 2xx, 3xx (redirects), 304 (cache hit)
  const isSuccess = (status >= 200 && status < 400);
  
  if (isSuccess) {
    metrics.successRequests++;
  } else {
    metrics.errorRequests++;
  }
  
  if (wasCacheHit) {
    metrics.cacheHits++;
  }
  
  metrics.requestsByStatus[status] = (metrics.requestsByStatus[status] || 0) + 1;
}

export function getScraperMetrics() {
  const successRate = metrics.totalRequests > 0 
    ? (metrics.successRequests / metrics.totalRequests) * 100 
    : 0;
  
  const cacheHitRate = metrics.totalRequests > 0
    ? (metrics.cacheHits / metrics.totalRequests) * 100
    : 0;
  
  const avgLatency = metrics.totalRequests > 0
    ? metrics.totalLatency / metrics.totalRequests
    : 0;
  
  return {
    totalRequests: metrics.totalRequests,
    successRate: Math.round(successRate * 100) / 100,
    cacheHitRate: Math.round(cacheHitRate * 100) / 100,
    avgLatency: Math.round(avgLatency),
    requestsByStatus: metrics.requestsByStatus
  };
}

export function resetScraperMetrics() {
  metrics.totalRequests = 0;
  metrics.successRequests = 0;
  metrics.errorRequests = 0;
  metrics.cacheHits = 0;
  metrics.totalLatency = 0;
  metrics.requestsByStatus = {};
}
