import { InlineKeyboardMarkup, InlineKeyboardButton } from 'telegraf/types';
import { isInlineCommandsEnabled } from '../utils/env.js';

/**
 * Button definition for inline keyboard
 */
export interface InlineButton {
  text: string;           // Display text on the button
  callbackData: string;   // Callback data (max 64 bytes)
}

/**
 * Create inline keyboard markup from button definitions
 * 
 * @param buttons - Array of button definitions
 * @param buttonsPerRow - Number of buttons per row (default: 2)
 * @returns InlineKeyboardMarkup or undefined if feature disabled or too many buttons
 */
export function createInlineKeyboard(
  buttons: InlineButton[],
  buttonsPerRow: number = 2
): InlineKeyboardMarkup | undefined {
  // Check feature flag
  if (!isInlineCommandsEnabled()) {
    return undefined;
  }

  // Check button count limit (max 5 as per requirements)
  if (buttons.length === 0 || buttons.length > 5) {
    return undefined;
  }

  // Create keyboard rows
  const keyboard: InlineKeyboardButton[][] = [];
  
  for (let i = 0; i < buttons.length; i += buttonsPerRow) {
    const row: InlineKeyboardButton[] = buttons
      .slice(i, i + buttonsPerRow)
      .map(btn => ({
        text: btn.text,
        callback_data: btn.callbackData
      }));
    keyboard.push(row);
  }

  return {
    inline_keyboard: keyboard
  };
}

/**
 * Create inline keyboard for /start command
 */
export function createStartKeyboard(): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '⏰ Установить часовой пояс', callbackData: '/timezone' },
    { text: '➕ Создать дайджест', callbackData: '/digest_add' },
    { text: '📖 Все команды', callbackData: '/help' }
  ], 2);
}

/**
 * Create inline keyboard for timezone quick selection
 */
export function createTimezoneQuickSelectKeyboard(): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '🇷🇺 Москва', callbackData: '/timezone Europe/Moscow' },
    { text: '🇵🇹 Лиссабон', callbackData: '/timezone Europe/Lisbon' },
    { text: '🇬🇧 Лондон', callbackData: '/timezone Europe/London' },
    { text: '🇺🇸 Нью-Йорк', callbackData: '/timezone America/New_York' }
  ], 2);
}

/**
 * Create inline keyboard for frequency selection
 */
export function createFrequencyKeyboard(): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '📅 Ежедневно', callbackData: '1' },
    { text: '📆 Еженедельно', callbackData: '2' }
  ], 2);
}

/**
 * Create inline keyboard for Yes/No confirmation
 */
export function createConfirmationKeyboard(): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '✅ ДА', callbackData: 'ДА' },
    { text: '❌ НЕТ', callbackData: 'НЕТ' }
  ], 2);
}

/**
 * Create inline keyboard for channel list with delete buttons
 */
export function createChannelListKeyboard(digestId: string, channels: Array<{ id: string; username: string }>): InlineKeyboardMarkup | undefined {
  const buttons = channels.map(channel => ({
    text: `🗑 Удалить ${channel.username}`,
    callbackData: `del_ch_${digestId}_${channel.id}`
  }));
  
  return createInlineKeyboard(buttons, 1);
}

/**
 * Create inline keyboard for digest creation success
 * 
 * @param digestName - Name of the created digest
 */
export function createDigestCreatedKeyboard(digestName: string): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '📡 Добавить каналы', callbackData: `/channel_add ${digestName}` },
    { text: '📋 Все дайджесты', callbackData: '/digest_list' }
  ], 2);
}

/**
 * Create inline keyboard for digest list
 * 
 * @param digestCount - Number of user's digests
 * @param singleDigestName - Name of the single digest (if only one exists)
 */
export function createDigestListKeyboard(
  digestCount: number,
  singleDigestName?: string
): InlineKeyboardMarkup | undefined {
  if (digestCount === 1 && singleDigestName) {
    // Single digest: add digest name to commands
    return createInlineKeyboard([
      { text: '✏️ Редактировать', callbackData: `/digest_edit ${singleDigestName}` },
      { text: '🗑 Удалить', callbackData: `/digest_delete ${singleDigestName}` },
      { text: '📡 Добавить каналы', callbackData: `/channel_add ${singleDigestName}` },
      { text: '🧪 Тест', callbackData: `/test_run ${singleDigestName}` }
    ], 2);
  } else {
    // Multiple digests: just command without arguments
    return createInlineKeyboard([
      { text: '✏️ Редактировать', callbackData: '/digest_edit' },
      { text: '🗑 Удалить', callbackData: '/digest_delete' },
      { text: '📡 Добавить каналы', callbackData: '/channel_add' },
      { text: '🧪 Тест', callbackData: '/test_run' }
    ], 2);
  }
}

/**
 * Create inline keyboard after channels added
 * 
 * @param digestName - Name of the digest
 */
export function createChannelsAddedKeyboard(digestName: string): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '📡 Список каналов', callbackData: `/channel_list ${digestName}` },
    { text: '🧪 Тестовый запуск', callbackData: `/test_run ${digestName}` }
  ], 2);
}

/**
 * Create inline keyboard for digest edit menu
 */
export function createDigestEditKeyboard(): InlineKeyboardMarkup | undefined {
  return createInlineKeyboard([
    { text: '📝 Имя', callbackData: '1' },
    { text: '🕐 Время', callbackData: '2' },
    { text: '📅 Периодичность', callbackData: '3' },
    { text: '⏯ Вкл/Выкл', callbackData: '4' },
    { text: '🗑 Удалить навсегда', callbackData: '5' }
  ], 2);
}
