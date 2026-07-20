import OpenAI from 'openai';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

// Environment configuration
export const OPENAI_CONFIG = {
  SUMMARY_MODEL: process.env.OPENAI_SUMMARY_MODEL || 'gpt-5-mini',
  FALLBACK_MODEL: process.env.OPENAI_FALLBACK_MODEL || 'gpt-4.1-mini',
  ENDPOINT: process.env.OPENAI_ENDPOINT || 'auto', // auto | responses | chat
  DEBUG: process.env.OPENAI_DEBUG === 'true',
  RATE_LIMIT_MAX_RETRIES: 3,
  RATE_LIMIT_RETRY_DELAYS: [30000, 60000, 120000] // 30s, 60s, 120s
} as const;

export interface OpenAIRequest {
  messages: Array<{ role: string; content: string }>;
  model: string;
  maxTokens: number;
  temperature?: number;
}

export interface OpenAIResponse {
  content: string;
  tokensUsed: number;
  requestId: string;
  endpointType: 'responses' | 'chat';
  finishReason: string | null;
  modelUsed: string;
  isEmpty?: boolean;
  status?: string;
  incompleteReason?: string;
  reasoningTokens?: number;
}

export class OpenAIAdapter {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    
    this.openai = new OpenAI({ apiKey });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isRateLimitError(error: any): boolean {
    return error?.status === 429 || 
           error?.code === 'rate_limit_exceeded' ||
           error?.message?.toLowerCase().includes('rate limit');
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    requestId: string
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= OPENAI_CONFIG.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (this.isRateLimitError(error) && attempt < OPENAI_CONFIG.RATE_LIMIT_MAX_RETRIES) {
          const delay = OPENAI_CONFIG.RATE_LIMIT_RETRY_DELAYS[attempt];
          
          logger.warn('Rate limit hit, retrying after delay', {
            requestId,
            operation: operationName,
            attempt: attempt + 1,
            maxRetries: OPENAI_CONFIG.RATE_LIMIT_MAX_RETRIES,
            delayMs: delay,
            error: error instanceof Error ? error.message : 'Unknown error'
          });

          await this.sleep(delay);
          continue;
        }

        throw error;
      }
    }

    logger.error('Max retries exceeded for rate limit', {
      requestId,
      operation: operationName,
      maxRetries: OPENAI_CONFIG.RATE_LIMIT_MAX_RETRIES,
      error: lastError instanceof Error ? lastError.message : 'Unknown error'
    });

    throw lastError;
  }

  /**
   * Generate completion with automatic endpoint routing and fallback
   */
  async generateCompletion(request: OpenAIRequest, attemptFallback = true): Promise<OpenAIResponse> {
    const fallbackRequestId = randomUUID(); // Only for logging before API call
    const { model, messages, maxTokens, temperature } = request;
    
    // Determine endpoint based on model
    const endpointType = this.determineEndpoint(model);
    
    try {
      if (OPENAI_CONFIG.DEBUG) {
        logger.info('OpenAI request initiated', {
          requestId: fallbackRequestId,
          model,
          endpointType,
          maxTokens,
          temperature,
          messageCount: messages.length
        });
      }

      let response: OpenAIResponse;
      
      if (endpointType === 'responses') {
        response = await this.callResponsesAPI(request, fallbackRequestId);
      } else {
        response = await this.callChatAPI(request, fallbackRequestId);
      }

      // Check if response is complete using appropriate logic for API type
      const isComplete = this.isResponseComplete(response, endpointType);
      const isIncomplete = !isComplete;
      
      if (isIncomplete) {
        logger.warn('OpenAI returned incomplete response', {
          requestId: response.requestId,
          model,
          endpointType,
          status: response.status,
          finishReason: response.finishReason,
          incompleteReason: response.incompleteReason,
          contentLength: response.content ? response.content.length : 0,
          tokensUsed: response.tokensUsed,
          reasoningTokens: response.reasoningTokens,
          currentMaxTokens: maxTokens
        });

        // Retry with increased max_output_tokens if not already at maximum
        if (maxTokens < 16000) {
          logger.info('Retrying with increased max_output_tokens', {
            requestId: response.requestId,
            originalMaxTokens: maxTokens,
            newMaxTokens: 16000,
            model
          });

          return await this.generateCompletion({
            ...request,
            maxTokens: 16000
          }, attemptFallback); // Preserve fallback capability
        }

        // If already at max tokens, try fallback model
        if (attemptFallback && model !== OPENAI_CONFIG.FALLBACK_MODEL) {
          logger.info('Max tokens exhausted, attempting fallback to alternative model', {
            requestId: response.requestId,
            originalModel: model,
            fallbackModel: OPENAI_CONFIG.FALLBACK_MODEL,
            maxTokens: 16000
          });

          return await this.generateCompletion({
            ...request,
            model: OPENAI_CONFIG.FALLBACK_MODEL,
            maxTokens: 16000
          }, false);
        }

        // Return incomplete response if no more retries/fallbacks available
        logger.error('Incomplete response with no fallback options remaining', {
          requestId: response.requestId,
          model,
          contentLength: response.content ? response.content.length : 0
        });
      }

      // Validate response content
      if (!response.content || response.content.trim().length === 0) {
        logger.warn('OpenAI returned empty content', {
          requestId: response.requestId,
          model,
          endpointType,
          finishReason: response.finishReason,
          tokensUsed: response.tokensUsed
        });

        // Attempt fallback if enabled
        if (attemptFallback && model !== OPENAI_CONFIG.FALLBACK_MODEL) {
          logger.info('Attempting fallback to alternative model', {
            requestId: response.requestId,
            originalModel: model,
            fallbackModel: OPENAI_CONFIG.FALLBACK_MODEL
          });

          return await this.generateCompletion({
            ...request,
            model: OPENAI_CONFIG.FALLBACK_MODEL
          }, false); // Prevent infinite fallback
        }

        // Special response for empty content after fallback
        return {
          content: '',
          tokensUsed: response.tokensUsed,
          requestId: response.requestId,
          endpointType: response.endpointType,
          finishReason: response.finishReason,
          modelUsed: response.modelUsed,
          isEmpty: true
        };
      }

      // Validate finish reason for other unexpected cases
      if (response.finishReason && !['stop', 'length', null].includes(response.finishReason)) {
        logger.warn('OpenAI finished with unexpected reason', {
          requestId: response.requestId,
          model,
          finishReason: response.finishReason,
          tokensUsed: response.tokensUsed
        });

        // Attempt fallback for problematic finish reasons
        if (attemptFallback && model !== OPENAI_CONFIG.FALLBACK_MODEL) {
          return await this.generateCompletion({
            ...request,
            model: OPENAI_CONFIG.FALLBACK_MODEL
          }, false);
        }
      }

      if (OPENAI_CONFIG.DEBUG) {
        logger.info('OpenAI request completed successfully', {
          requestId: response.requestId,
          model: response.modelUsed,
          endpointType: response.endpointType,
          finishReason: response.finishReason,
          contentLength: response.content.length,
          tokensUsed: response.tokensUsed
        });
      }

      return response;

    } catch (error) {
      logger.error('OpenAI request failed', {
        requestId: fallbackRequestId,
        model,
        endpointType,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      // Attempt fallback on error if enabled
      if (attemptFallback && model !== OPENAI_CONFIG.FALLBACK_MODEL) {
        logger.info('Attempting fallback due to error', {
          requestId: fallbackRequestId,
          originalModel: model,
          fallbackModel: OPENAI_CONFIG.FALLBACK_MODEL
        });

        try {
          return await this.generateCompletion({
            ...request,
            model: OPENAI_CONFIG.FALLBACK_MODEL
          }, false);
        } catch (fallbackError) {
          logger.error('Fallback model also failed', {
            requestId: fallbackRequestId,
            fallbackModel: OPENAI_CONFIG.FALLBACK_MODEL,
            error: fallbackError instanceof Error ? fallbackError.message : 'Unknown error'
          });
        }
      }

      throw error;
    }
  }

  /**
   * Determine which API endpoint to use based on model
   * GPT-5 models MUST use Responses API
   * All other models (including fallback gpt-4o) use Chat API
   */
  private determineEndpoint(model: string): 'responses' | 'chat' {
    // Allow manual override via environment variable
    if (OPENAI_CONFIG.ENDPOINT === 'responses') return 'responses';
    if (OPENAI_CONFIG.ENDPOINT === 'chat') return 'chat';
    
    // Fixed routing: GPT-5 → Responses API, everything else → Chat API
    const modelLower = model.toLowerCase();
    if (modelLower.includes('gpt-5')) {
      return 'responses';
    }
    
    // All other models (gpt-4o, gpt-4o-mini, gpt-4, gpt-3.5-turbo, etc.) use Chat API
    return 'chat';
  }

  /**
   * Check if response is complete based on API type
   * For Responses API: status is the source of truth
   * For Chat API: finishReason determines completion
   */
  private isResponseComplete(response: OpenAIResponse, endpointType: string): boolean {
    if (endpointType === 'responses') {
      // For Responses API: status == "completed" + has content = complete
      return response.status === 'completed' && 
             !!response.content && 
             response.content.trim().length > 0;
    } else {
      // For Chat API: finishReason == "stop" = complete
      return response.finishReason === 'stop';
    }
  }

  /**
   * Call OpenAI Responses API (for GPT-5)
   */
  private async callResponsesAPI(request: OpenAIRequest, requestId: string): Promise<OpenAIResponse> {
    const { model, messages, maxTokens, temperature } = request;
    
    // Separate system and user messages for Responses API
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const userMessages = messages.filter(msg => msg.role === 'user');
    
    // Use instructions for system prompts, input for user prompts
    const instructions = systemMessages.map(msg => msg.content).join('\n');
    const input = userMessages.map(msg => msg.content).join('\n');
    
    const params: any = {
      model,
      instructions,
      input,
      max_output_tokens: maxTokens
    };

    // Note: GPT-5 Responses API does not support temperature parameter
    // Temperature is handled differently in Responses API vs Chat API

    try {
      if (OPENAI_CONFIG.DEBUG) {
        logger.info('Responses API request', {
          requestId,
          model,
          endpointType: 'responses',
          params: { ...params, instructions: '[REDACTED]', input: '[REDACTED]' }
        });
      }

      const response = await this.retryWithBackoff(
        async () => await (this.openai as any).responses.create(params),
        'Responses API',
        requestId
      );
      
      const content = this.parseResponsesContent(response);
      const tokensUsed = response.usage?.output_tokens || response.usage?.total_tokens || 0;
      const reasoningTokens = response.usage?.output_tokens_details?.reasoning_tokens || 0;
      const finishReason = this.parseResponsesFinishReason(response);
      const actualRequestId = response.id || requestId;

      if (OPENAI_CONFIG.DEBUG) {
        logger.info('Responses API response', {
          requestId: actualRequestId,
          model,
          endpointType: 'responses',
          finishReason,
          usage: response.usage,
          reasoningTokens,
          contentLength: content.length
        });
      }

      return {
        content,
        tokensUsed,
        requestId: actualRequestId,
        endpointType: 'responses',
        finishReason,
        modelUsed: model,
        status: response.status || 'unknown',
        incompleteReason: response.incomplete_details?.reason || undefined,
        reasoningTokens
      };
    } catch (error) {
      logger.error('Responses API call failed', {
        requestId,
        model,
        error: error instanceof Error ? error.message : 'Unknown error',
        endpointType: 'responses',
        // Log sanitized params for debugging (remove PII)
        params: { ...params, instructions: '[REDACTED]', input: '[REDACTED]' }
      });
      throw error;
    }
  }

  /**
   * Call OpenAI Chat Completions API (standard models)
   */
  private async callChatAPI(request: OpenAIRequest, requestId: string): Promise<OpenAIResponse> {
    const { model, messages, maxTokens, temperature } = request;

    const params: any = {
      model,
      messages,
      max_tokens: maxTokens
    };

    // Only add temperature for non-GPT-5 models
    if (!model.toLowerCase().includes('gpt-5') && temperature !== undefined) {
      params.temperature = temperature;
    }

    try {
      if (OPENAI_CONFIG.DEBUG) {
        logger.info('Chat API request', {
          requestId,
          model,
          endpointType: 'chat',
          params: { ...params, messages: '[REDACTED]' }
        });
      }

      const response = await this.retryWithBackoff(
        async () => await this.openai.chat.completions.create(params),
        'Chat API',
        requestId
      );
      
      const content = this.parseChatContent(response);
      const tokensUsed = response.usage?.total_tokens || 0;
      const reasoningTokens = response.usage?.completion_tokens_details?.reasoning_tokens || 0;
      const finishReason = response.choices[0]?.finish_reason || null;
      const actualRequestId = response.id || requestId;

      if (OPENAI_CONFIG.DEBUG) {
        logger.info('Chat API response', {
          requestId: actualRequestId,
          model,
          endpointType: 'chat',
          finishReason,
          usage: response.usage,
          reasoningTokens,
          contentLength: content.length
        });
      }

      return {
        content,
        tokensUsed,
        requestId: actualRequestId,
        endpointType: 'chat',
        finishReason,
        modelUsed: model,
        reasoningTokens
      };
    } catch (error) {
      logger.error('Chat API call failed', {
        requestId,
        model,
        error: error instanceof Error ? error.message : 'Unknown error',
        endpointType: 'chat',
        // Log sanitized params for debugging
        params: { ...params, messages: '[REDACTED]' }
      });
      throw error;
    }
  }

  /**
   * Parse content from Responses API response
   */
  private parseResponsesContent(response: any): string {
    // Priority order for Responses API (ENHANCED for GPT-5 reasoning mode):
    // 1. output_text (primary field for GPT-5)
    // 2. output[].content[] where type in {"text","output_text"} -> collect .text
    // 3. output[].summary (GPT-5 structured output - CRITICAL FIX)
    // 4. output[].text (direct text in output items)
    // 5. reasoning.summary (GPT-5 reasoning mode primary field - CRITICAL FIX)
    // 6. reasoning.content/text (GPT-5 reasoning mode alternate fields)
    // 7. text as object (extract content/text/value/message/summary - ENHANCED SAFETY)
    // 8. text as string (fallback)
    // 9. choices[0].message.content (fallback, similar to Chat API)
    
    // Try output_text first
    if (response.output_text && typeof response.output_text === 'string') {
      return response.output_text.trim();
    }
    
    // Try output[].content[].text structure (ENHANCED for GPT-5)
    if (response.output && Array.isArray(response.output)) {
      const texts: string[] = [];
      for (const item of response.output) {
        // Try nested content array
        if (item.content && Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            // Accept ANY content item with text, not just specific types
            if (contentItem.text && typeof contentItem.text === 'string') {
              texts.push(contentItem.text);
            }
            // Try text as object with value/content/text fields
            else if (contentItem.text && typeof contentItem.text === 'object') {
              if (contentItem.text.value && typeof contentItem.text.value === 'string') {
                texts.push(contentItem.text.value);
              } else if (contentItem.text.content && typeof contentItem.text.content === 'string') {
                texts.push(contentItem.text.content);
              } else if (contentItem.text.text && typeof contentItem.text.text === 'string') {
                texts.push(contentItem.text.text);
              }
            }
          }
        }
        
        // Try direct text field in output item
        if (item.text) {
          if (typeof item.text === 'string') {
            texts.push(item.text);
          } else if (typeof item.text === 'object') {
            // Extract from object form
            if (item.text.value && typeof item.text.value === 'string') {
              texts.push(item.text.value);
            } else if (item.text.content && typeof item.text.content === 'string') {
              texts.push(item.text.content);
            } else if (item.text.text && typeof item.text.text === 'string') {
              texts.push(item.text.text);
            }
          }
        }
      }
      if (texts.length > 0) {
        return texts.join('\n').trim();
      }
    }
    
    // Try output[].summary field (GPT-5 structured output - CRITICAL FIX)
    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        // summary as string
        if (item.summary && typeof item.summary === 'string') {
          return item.summary.trim();
        }
        // summary as object (extract from value/content/text/message fields)
        if (item.summary && typeof item.summary === 'object') {
          const summaryFields = ['content', 'text', 'value', 'message'];
          for (const field of summaryFields) {
            if (item.summary[field] && typeof item.summary[field] === 'string') {
              return item.summary[field].trim();
            }
          }
        }
      }
    }
    
    // Try reasoning field (GPT-5 reasoning mode)
    if (response.reasoning) {
      if (typeof response.reasoning === 'string') {
        return response.reasoning.trim();
      }
      // reasoning as object with content/text/summary (ENHANCED)
      if (typeof response.reasoning === 'object') {
        // CRITICAL: Check reasoning.summary first (GPT-5 reasoning mode primary field)
        if (response.reasoning.summary && typeof response.reasoning.summary === 'string') {
          return response.reasoning.summary.trim();
        }
        if (response.reasoning.content && typeof response.reasoning.content === 'string') {
          return response.reasoning.content.trim();
        }
        if (response.reasoning.text && typeof response.reasoning.text === 'string') {
          return response.reasoning.text.trim();
        }
      }
    }
    
    // Try text field (can be object or string) - ENHANCED SAFETY
    if (response.text) {
      // text as string
      if (typeof response.text === 'string') {
        return response.text.trim();
      }
      // text as object - try to extract content from typical text fields
      // NOTE: Ignore metadata fields like 'format', 'verbosity', etc.
      if (typeof response.text === 'object') {
        const textFields = ['content', 'text', 'value', 'message', 'summary'];
        for (const field of textFields) {
          if (response.text[field] && typeof response.text[field] === 'string') {
            return response.text[field].trim();
          }
        }
      }
    }
    
    // Fallback: Try choices array (similar to Chat API)
    if (response.choices && Array.isArray(response.choices) && response.choices[0]) {
      const choice = response.choices[0];
      
      // Try message.content as string
      if (choice.message?.content && typeof choice.message.content === 'string') {
        return choice.message.content.trim();
      }
      
      // Try message.content as array
      if (choice.message?.content && Array.isArray(choice.message.content)) {
        const texts: string[] = [];
        for (const item of choice.message.content as any[]) {
          if (item?.type === 'text' && item?.text && typeof item.text === 'string') {
            texts.push(item.text);
          }
        }
        if (texts.length > 0) {
          return texts.join('\n').trim();
        }
      }
    }
    
    // Log shape-only diagnostics. Never log response content or reasoning text.
    logger.warn('Responses API returned no parseable content', {
      hasOutputText: !!response.output_text,
      outputTextType: typeof response.output_text,
      hasOutput: !!response.output,
      outputIsArray: Array.isArray(response.output),
      outputLength: Array.isArray(response.output) ? response.output.length : 0,
      output0Structure: Array.isArray(response.output) && response.output[0] ? Object.keys(response.output[0]) : null,
      output0HasContent: Array.isArray(response.output) && response.output[0] ? !!response.output[0].content : false,
      output0ContentIsArray: Array.isArray(response.output) && response.output[0]?.content ? Array.isArray(response.output[0].content) : false,
      output0ContentLength: Array.isArray(response.output) && response.output[0]?.content && Array.isArray(response.output[0].content) ? response.output[0].content.length : 0,
      hasChoices: !!response.choices,
      choicesLength: Array.isArray(response.choices) ? response.choices.length : 0,
      hasText: !!response.text,
      textType: typeof response.text,
      textStructure: response.text && typeof response.text === 'object' ? Object.keys(response.text) : null,
      hasReasoning: !!response.reasoning,
      reasoningType: typeof response.reasoning,
      reasoningStructure: response.reasoning && typeof response.reasoning === 'object' ? Object.keys(response.reasoning) : null,
      responseKeys: Object.keys(response || {}),
      usage: response.usage,
      finishReason: response.finish_reason,
      id: response.id
    });
    
    return '';
  }

  /**
   * Parse finish_reason from Responses API response
   */
  private parseResponsesFinishReason(response: any): string | null {
    // CRITICAL: Map incomplete_details.reason to finish_reason (GPT-5 pattern)
    if (response.incomplete_details?.reason) {
      // Map max_output_tokens to 'length' for consistency with Chat API
      if (response.incomplete_details.reason === 'max_output_tokens') {
        return 'length';
      }
      // Pass through other incomplete reasons
      return response.incomplete_details.reason;
    }
    
    // For Responses API, finish_reason might be in different locations
    if (response.finish_reason) {
      return response.finish_reason;
    }
    
    // Check in choices array if available
    if (response.choices && Array.isArray(response.choices) && response.choices[0]) {
      return response.choices[0].finish_reason || null;
    }
    
    // Check in output array
    if (response.output && Array.isArray(response.output) && response.output[0]) {
      return response.output[0].finish_reason || null;
    }
    
    return null;
  }

  /**
   * Parse content from Chat Completions API response
   */
  private parseChatContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
    const choice = response.choices[0];
    if (!choice) return '';

    // Priority order for Chat API:
    // 1. choices[0].message.content as string
    // 2. choices[0].message.content[] with elements {type:"text", text}
    
    const message = choice.message;
    if (!message) return '';

    // Case 1: Simple string content
    if (typeof message.content === 'string') {
      return message.content.trim();
    }

    // Case 2: Array of content items
    if (Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const item of message.content as any[]) {
        if (item?.type === 'text' && item?.text && typeof item.text === 'string') {
          texts.push(item.text);
        }
      }
      if (texts.length > 0) {
        return texts.join('\n').trim();
      }
    }

    return '';
  }
}

export const openaiAdapter = new OpenAIAdapter();
