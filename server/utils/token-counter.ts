import { encoding_for_model, TiktokenModel } from 'tiktoken';
import { logger } from './logger.js';

export const TOKEN_LIMITS = {
  GPT_5_TPM: 30000,
  GPT_4O_TPM: 30000,
  SAFETY_BUFFER: 2000,
  MAX_SAFE_TOKENS: 28000
} as const;

export interface TokenCount {
  total: number;
  systemPrompt: number;
  userContent: number;
  estimatedOutput: number;
}

export class TokenCounter {
  private static getEncoding(model: string) {
    try {
      const modelName = model.toLowerCase();
      if (modelName.includes('gpt-5')) {
        return encoding_for_model('gpt-4o' as TiktokenModel);
      }
      if (modelName.includes('gpt-4o')) {
        return encoding_for_model('gpt-4o' as TiktokenModel);
      }
      if (modelName.includes('gpt-4')) {
        return encoding_for_model('gpt-4' as TiktokenModel);
      }
      return encoding_for_model('gpt-3.5-turbo' as TiktokenModel);
    } catch (error) {
      logger.warn('Failed to get encoding for model, using gpt-4o', {
        model,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return encoding_for_model('gpt-4o' as TiktokenModel);
    }
  }

  static countTokens(text: string, model: string = 'gpt-4o'): number {
    try {
      const encoding = this.getEncoding(model);
      const tokens = encoding.encode(text);
      const count = tokens.length;
      encoding.free();
      return count;
    } catch (error) {
      logger.error('Failed to count tokens', {
        model,
        textLength: text.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return Math.ceil(text.length / 4);
    }
  }

  static countPromptTokens(
    messages: Array<{ role: string; content: string }>,
    model: string = 'gpt-4o'
  ): TokenCount {
    try {
      let systemPrompt = 0;
      let userContent = 0;

      for (const message of messages) {
        const tokens = this.countTokens(message.content, model);
        const overhead = 4;
        
        if (message.role === 'system') {
          systemPrompt += tokens + overhead;
        } else {
          userContent += tokens + overhead;
        }
      }

      const total = systemPrompt + userContent;

      return {
        total,
        systemPrompt,
        userContent,
        estimatedOutput: 0
      };
    } catch (error) {
      logger.error('Failed to count prompt tokens', {
        model,
        messageCount: messages.length,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      const roughEstimate = messages.reduce((sum, msg) => sum + Math.ceil(msg.content.length / 4), 0);
      return {
        total: roughEstimate,
        systemPrompt: 0,
        userContent: roughEstimate,
        estimatedOutput: 0
      };
    }
  }

  static isSafeToSend(tokenCount: TokenCount, maxOutputTokens: number): boolean {
    const totalWithOutput = tokenCount.total + maxOutputTokens;
    return totalWithOutput <= TOKEN_LIMITS.MAX_SAFE_TOKENS;
  }

  static getReductionNeeded(tokenCount: TokenCount, maxOutputTokens: number): number {
    const totalWithOutput = tokenCount.total + maxOutputTokens;
    if (totalWithOutput <= TOKEN_LIMITS.MAX_SAFE_TOKENS) {
      return 0;
    }
    return totalWithOutput - TOKEN_LIMITS.MAX_SAFE_TOKENS;
  }
}
