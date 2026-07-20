import { logger } from '../utils/logger.js';
import { fetchPublicChannel } from '../telegram/web-scraper.js';
import { storage } from '../storage.js';

interface ChannelData {
  channel: string;
  posts: Array<{
    dt: string;
    text: string;
    links: string[];
    url: string;
  }>;
  status: 'ok' | 'unavailable_or_private' | 'rate_limited' | 'error';
  message?: string;
}

class IngestionService {
  async collectPosts(
    channelUsernames: string[],
    windowStart: Date,
    windowEnd: Date
  ): Promise<ChannelData[]> {
    logger.info('Starting web scraping collection', {
      channelCount: channelUsernames.length,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    });

    const results: ChannelData[] = [];

    for (const username of channelUsernames) {
      try {
        // Get channel from DB for cursor state
        const channel = await storage.getChannelByUsername(username);
        
        if (!channel) {
          logger.warn('Channel not found in DB, skipping', { username });
          results.push({
            channel: username,
            posts: [],
            status: 'error',
            message: 'Channel not found in database'
          });
          continue;
        }

        // Check if channel is unavailable (permanent)
        if (channel.fetchStatus === 'unavailable') {
          logger.debug('Skipping unavailable channel', { username });
          results.push({
            channel: username,
            posts: [],
            status: 'unavailable_or_private',
            message: 'Channel permanently unavailable'
          });
          continue;
        }

        // Check if degraded channel is ready for retry
        if (channel.fetchStatus === 'degraded' && channel.retryAfter && channel.retryAfter > new Date()) {
          logger.debug('Skipping degraded channel (retry later)', { 
            username, 
            retryAfter: channel.retryAfter.toISOString() 
          });
          results.push({
            channel: username,
            posts: [],
            status: 'error',
            message: `Channel degraded, retry after ${channel.retryAfter.toISOString()}`
          });
          continue;
        }

        // Robust pagination loop with before-based pagination
        const paginationResult = await this.fetchChannelWithPagination(
          channel,
          username,
          windowStart,
          windowEnd
        );

        // Handle various statuses
        if (paginationResult.status === 'cached') {
          logger.info('Cache hit: channel not modified', { username });
          results.push({
            channel: username,
            posts: [],
            status: 'ok',
            message: 'No new posts (cached)'
          });
          continue;
        }

        if (paginationResult.status === 'error') {
          await this.handleScraperError(channel.id, username, paginationResult.error || 'Unknown error');
          results.push({
            channel: username,
            posts: [],
            status: 'error',
            message: paginationResult.error
          });
          continue;
        }

        // Success - update pagination state
        const formattedPosts = paginationResult.posts.map(post => ({
          dt: post.dt,
          text: post.text,
          links: this.extractLinks(post.text),
          url: post.url
        }));

        // Update pagination state
        if (paginationResult.minId && paginationResult.maxId) {
          await storage.updatePaginationState(channel.id, {
            lowestMessageId: paginationResult.minId.toString(),
            lastSeenMessageId: paginationResult.maxId.toString(),
            lastDeepFetchAt: new Date()
          });
        }

        // Update cursor and etag
        if (paginationResult.maxId) {
          await storage.updateChannelCursor(
            channel.id,
            paginationResult.maxId.toString(),
            paginationResult.etag,
            new Date()
          );
        }

        // Reset pagination failures on success
        await storage.resetPaginationFailures(channel.id);

        // Mark as active (recovery from degraded)
        if (channel.fetchStatus !== 'active') {
          await storage.markChannelStatus(channel.id, 'active');
        }

        results.push({
          channel: username,
          posts: formattedPosts,
          status: 'ok'
        });

        logger.info('Channel scraped successfully with pagination', {
          channel: username,
          postsCount: formattedPosts.length,
          pagesFetched: paginationResult.pagesFetched,
          steppingUsed: paginationResult.steppingUsed,
          minId: paginationResult.minId,
          maxId: paginationResult.maxId
        });

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        
        logger.error('Failed to collect posts from channel', {
          channel: username,
          error: errorMessage
        });

        results.push({
          channel: username,
          posts: [],
          status: 'error',
          message: errorMessage
        });
      }
    }

    logger.info('Web scraping batch completed', {
      totalChannels: channelUsernames.length,
      successCount: results.filter(r => r.status === 'ok').length,
      privateCount: results.filter(r => r.status === 'unavailable_or_private').length,
      errorCount: results.filter(r => r.status === 'error').length
    });

    return results;
  }

  /**
   * Robust pagination loop using before-based pagination with fallbacks
   * Implements recommendations for handling 50+ posts/day channels
   */
  private async fetchChannelWithPagination(
    channel: any,
    username: string,
    windowStart: Date,
    windowEnd: Date
  ): Promise<{
    status: 'ok' | 'cached' | 'error';
    posts: Array<{ id: number; dt: string; text: string; url: string }>;
    minId?: number;
    maxId?: number;
    pagesFetched: number;
    steppingUsed: boolean;
    error?: string;
    etag?: string;
  }> {
    const MAX_PAGES = 10; // Safety limit (~200 posts max)
    const STEPPING_OFFSETS = [1, 5, 10, 50]; // Try cursor-1, -5, -10, -50 on "No posts"
    
    const allPosts: Array<{ id: number; dt: string; text: string; url: string }> = [];
    const seenIds = new Set<number>();
    let cursor: number | undefined = undefined;
    let pageCount = 0;
    let consecutiveEmptyPages = 0;
    let steppingUsed = false;
    let lastMinId: number | undefined = undefined;
    let etag: string | undefined = undefined;
    
    // Start from latest page (no cursor)
    logger.debug('Starting pagination loop', { 
      username, 
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString()
    });
    
    while (pageCount < MAX_PAGES) {
      pageCount++;
      
      // Fetch page
      let scraperResult = await fetchPublicChannel(username, windowStart, windowEnd, {
        lastMessageId: cursor ? cursor.toString() : undefined,
        useBefore: cursor !== undefined, // Use ?before= for pagination, no param for first page
        etag: pageCount === 1 ? (channel.etag || undefined) : undefined,
        lastModified: pageCount === 1 ? channel.lastFetchedAt?.toUTCString() : undefined
      });
      
      // Handle 304 Not Modified (only on first page)
      if (scraperResult.wasNotModified) {
        return {
          status: 'cached',
          posts: [],
          pagesFetched: pageCount,
          steppingUsed
        };
      }
      
      // Handle errors
      if (scraperResult.status === 'error') {
        await storage.incrementPaginationFailures(channel.id);
        return {
          status: 'error',
          posts: allPosts,
          error: scraperResult.error,
          pagesFetched: pageCount,
          steppingUsed
        };
      }
      
      // Save ETag from first page
      if (pageCount === 1 && scraperResult.etag) {
        etag = scraperResult.etag;
      }
      
      // Extract parsed posts
      const pagePosts = scraperResult.posts.filter(post => {
        const postDate = new Date(post.dt);
        return postDate >= windowStart && postDate <= windowEnd;
      });
      
      // If no posts returned, try stepping fallbacks
      if (scraperResult.posts.length === 0 && cursor) {
        logger.debug('No posts found, trying stepping fallbacks', { 
          username, 
          cursor, 
          pageCount 
        });
        
        steppingUsed = true;
        let foundWithStepping = false;
        let steppedResult: any = null;
        
        for (const offset of STEPPING_OFFSETS) {
          const steppedCursor = cursor - offset;
          if (steppedCursor < 1) continue;
          
          logger.debug('Trying stepped cursor', { username, steppedCursor, offset });
          
          steppedResult = await fetchPublicChannel(username, windowStart, windowEnd, {
            lastMessageId: steppedCursor.toString(),
            useBefore: true
          });
          
          if (steppedResult.status === 'ok' && steppedResult.posts.length > 0) {
            foundWithStepping = true;
            logger.info('Stepping fallback successful', { 
              username, 
              offset, 
              postsFound: steppedResult.posts.length,
              steppedMinId: steppedResult.minId,
              steppedMaxId: steppedResult.maxId
            });
            
            // CRITICAL: Replace scraperResult with steppedResult to propagate metadata
            // This ensures cursor progression, monotonic progress, and state tracking work correctly
            scraperResult = steppedResult;
            pageCount++; // Count the stepping fetch as an additional page
            break;
          }
        }
        
        if (!foundWithStepping) {
          logger.debug('No posts found even with stepping, stopping pagination', { username });
          break;
        }
        
        // Re-filter posts after stepping success (scraperResult now contains steppedResult)
        pagePosts.length = 0; // Clear previous empty results
        pagePosts.push(...scraperResult.posts.filter(post => {
          const postDate = new Date(post.dt);
          return postDate >= windowStart && postDate <= windowEnd;
        }));
      }
      
      // Deduplicate and add to collection
      let newPostsCount = 0;
      for (const post of pagePosts) {
        if (!seenIds.has(post.id)) {
          allPosts.push(post);
          seenIds.add(post.id);
          newPostsCount++;
        }
      }
      
      logger.debug('Page processed', { 
        username, 
        pageCount, 
        totalParsed: scraperResult.posts.length,
        inWindow: pagePosts.length,
        newPosts: newPostsCount,
        totalCollected: allPosts.length
      });
      
      // Check consecutive empty pages
      if (newPostsCount === 0) {
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 2) {
          logger.debug('Two consecutive pages without new posts, stopping', { username });
          break;
        }
      } else {
        consecutiveEmptyPages = 0;
      }
      
      // Calculate min ID from this page for monotonic progress check
      const pageMinId = scraperResult.minId;
      
      if (pageMinId === undefined || scraperResult.posts.length === 0) {
        // No more posts available
        logger.debug('No more posts available, stopping pagination', { username });
        break;
      }
      
      // Monotonic progress invariant: minId must decrease
      if (lastMinId !== undefined && pageMinId >= lastMinId) {
        logger.warn('Monotonic progress violated - minId did not decrease', { 
          username, 
          lastMinId, 
          pageMinId 
        });
        break;
      }
      
      lastMinId = pageMinId;
      cursor = pageMinId; // Next page starts before this minId
      
      // Check if oldest post is outside window
      const oldestPost = scraperResult.posts[scraperResult.posts.length - 1];
      if (oldestPost) {
        const oldestPostDate = new Date(oldestPost.dt);
        if (oldestPostDate < windowStart) {
          logger.debug('Reached posts outside window, stopping pagination', { 
            username, 
            oldestPostDate: oldestPostDate.toISOString(),
            windowStart: windowStart.toISOString()
          });
          break;
        }
      }
    }
    
    // Calculate final metadata
    const minId = allPosts.length > 0 ? Math.min(...allPosts.map(p => p.id)) : undefined;
    const maxId = allPosts.length > 0 ? Math.max(...allPosts.map(p => p.id)) : undefined;
    
    logger.info('Pagination loop completed', { 
      username, 
      totalPosts: allPosts.length,
      pagesFetched: pageCount,
      steppingUsed,
      minId,
      maxId
    });
    
    return {
      status: 'ok',
      posts: allPosts,
      minId,
      maxId,
      pagesFetched: pageCount,
      steppingUsed,
      etag
    };
  }

  private async handleScraperError(channelId: string, username: string, error: string): Promise<void> {
    // Handle 403 Forbidden - mark unavailable
    if (error.includes('403')) {
      logger.warn('Channel returned 403 - marking unavailable', { username });
      await storage.markChannelStatus(channelId, 'unavailable');
      return;
    }

    // Handle 429 Rate Limit - mark degraded with retry
    if (error.includes('429') || error.includes('Rate limit')) {
      const retryAfter = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      logger.warn('Rate limited - marking degraded', { username, retryAfter });
      await storage.markChannelStatus(channelId, 'degraded', retryAfter);
      return;
    }

    // Other errors - mark degraded with shorter retry
    const retryAfter = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    logger.warn('Scraping error - marking degraded', { username, error, retryAfter });
    await storage.markChannelStatus(channelId, 'degraded', retryAfter);
  }

  private extractLinks(text: string): string[] {
    const urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
    const matches = text.match(urlRegex);
    return matches || [];
  }

  async validateChannel(username: string): Promise<{
    isValid: boolean;
    isAccessible: boolean;
    title?: string;
    description?: string;
    error?: string;
  }> {
    // Simple validation using web scraping
    try {
      const testResult = await fetchPublicChannel(username, new Date(), new Date());
      
      if (testResult.status === 'ok') {
        return {
          isValid: true,
          isAccessible: true,
          title: username
        };
      }
      
      if (testResult.error?.includes('403')) {
        return {
          isValid: true,
          isAccessible: false,
          error: 'Channel is private or unavailable'
        };
      }
      
      return {
        isValid: false,
        isAccessible: false,
        error: testResult.error || 'Channel not found'
      };
    } catch (error) {
      return {
        isValid: false,
        isAccessible: false,
        error: error instanceof Error ? error.message : 'Validation failed'
      };
    }
  }
}

export const ingestionService = new IngestionService();