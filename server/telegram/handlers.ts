import { Context } from 'telegraf';
import { storage } from '../storage.js';
import { userService } from '../services/user.js';
import { schedulerService } from '../services/scheduler.js';
import { validateTimezone } from '../utils/timezone.js';
import { logger } from '../utils/logger.js';
import { getConversationState, setConversationState, clearConversationState } from './commands.js';
import { createDigestCreatedKeyboard, createChannelsAddedKeyboard, createDigestEditKeyboard, createFrequencyKeyboard, createConfirmationKeyboard } from './inline-keyboard.js';

const DIGEST_NAME_PATTERN = /^[\p{L}\p{N} _-]{2,50}$/u;

export const conversationHandlers = {
  async handleText(ctx: Context): Promise<void> {
    const user = ctx.from;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    
    if (!user || !text || text.startsWith('/')) return;

    const state = getConversationState(user.id);
    if (!state) return;

    try {
      await processConversationState(ctx, user.id, text, state);
    } catch (error) {
      logger.error('Conversation handler error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        command: state.command,
        step: state.step
      });
      
      clearConversationState(user.id);
      await ctx.reply('❌ Произошла ошибка. Попробуйте начать сначала.');
    }
  },

  async handleCallbackQuery(ctx: Context): Promise<void> {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) {
      return;
    }

    const callbackData = ctx.callbackQuery.data;
    const user = ctx.from;
    
    if (!user) {
      await ctx.answerCbQuery();
      return;
    }

    try {
      // Answer callback query first to remove loading state
      await ctx.answerCbQuery();

      logger.info('Processing callback query', {
        callbackType: callbackData.startsWith('/')
          ? callbackData.slice(1).split(' ', 1)[0]
          : callbackData.split(':', 1)[0]
      });

      // Check if it's a command (starts with /)
      if (callbackData.startsWith('/')) {
        // Parse command and arguments
        const parts = callbackData.split(' ');
        const command = parts[0].substring(1); // Remove leading /

        // Import command handlers dynamically
        const { commandHandlers } = await import('./commands.js');

        // Create a new context with modified message property
        const fakeMessage = {
          text: callbackData,
          message_id: ctx.callbackQuery.message?.message_id || 0,
          date: Math.floor(Date.now() / 1000),
          chat: ctx.chat!
        };

        // Use Object.create to create a new context with overridden message
        const modifiedCtx = Object.create(ctx);
        Object.defineProperty(modifiedCtx, 'message', {
          value: fakeMessage,
          writable: true,
          enumerable: true,
          configurable: true
        });

        // Route to appropriate command handler
        switch (command) {
          case 'start':
            await commandHandlers.start(modifiedCtx);
            break;
          case 'help':
            await commandHandlers.help(modifiedCtx);
            break;
          case 'timezone':
            await commandHandlers.timezone(modifiedCtx);
            break;
          case 'digest_add':
            await commandHandlers.digestAdd(modifiedCtx);
            break;
          case 'digest_list':
            await commandHandlers.digestList(modifiedCtx);
            break;
          case 'digest_edit':
            await commandHandlers.digestEdit(modifiedCtx);
            break;
          case 'digest_delete':
            await commandHandlers.digestDelete(modifiedCtx);
            break;
          case 'channel_add':
            await commandHandlers.channelAdd(modifiedCtx);
            break;
          case 'channel_list':
            await commandHandlers.channelList(modifiedCtx);
            break;
          case 'channel_remove':
            await commandHandlers.channelRemove(modifiedCtx);
            break;
          case 'test_run':
            await commandHandlers.testRun(modifiedCtx);
            break;
          default:
            await ctx.reply(`❌ Неизвестная команда: ${command}`);
        }
      } else if (callbackData.startsWith('del_ch_')) {
        // New short format for channel deletion: del_ch_${digestId}_${channelId}
        const parts = callbackData.split('_');
        if (parts.length === 4) {
          const digestId = parts[2];
          const channelId = parts[3];
          
          try {
            // Get digest and channel info for confirmation message
            const digest = await storage.getDigest(digestId);
            const channel = await storage.getChannel(channelId);
            
            if (!digest || !channel) {
              await ctx.reply('❌ Дайджест или канал не найден.');
              return;
            }
            
            // Verify user owns this digest
            const dbUser = await storage.getUserByTelegramId(String(user.id));
            if (!dbUser || digest.userId !== dbUser.id) {
              await ctx.reply('❌ У вас нет прав на изменение этого дайджеста.');
              return;
            }
            
            // SECURITY: Verify channel belongs to this digest
            const digestChannels = await storage.getDigestChannels(digestId);
            const channelBelongsToDigest = digestChannels.some(c => c.id === channelId);
            
            if (!channelBelongsToDigest) {
              logger.warn('Attempted unauthorized channel deletion', {
                digestId,
                channelId,
                channelUsername: channel.username
              });
              await ctx.reply('❌ Этот канал не принадлежит данному дайджесту.');
              return;
            }
            
            // Remove channel from digest
            await userService.removeChannelFromDigest(digestId, channel.username);
            await ctx.reply(`✅ Канал ${channel.username} удален из дайджеста "${digest.name}".`);
            
            logger.info('Channel removed via button', {
              digestId,
              channelId,
              channelUsername: channel.username
            });
          } catch (error) {
            logger.error('Channel deletion error', {
              error: error instanceof Error ? error.message : 'Unknown error',
              userId: user.id,
              digestId,
              channelId
            });
            await ctx.reply(`❌ ${error instanceof Error ? error.message : 'Ошибка при удалении канала'}`);
          }
        } else {
          await ctx.reply('❌ Неверный формат данных кнопки.');
        }
      } else {
        // It's a menu choice (number 1-4)
        const state = getConversationState(user.id);
        
        if (state) {
          // Process as text input (menu choice)
          await processConversationState(ctx, user.id, callbackData, state);
        } else {
          await ctx.reply('❌ Нет активного диалога. Используйте команды для начала работы.');
        }
      }
    } catch (error) {
      logger.error('Callback query handler error', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      await ctx.reply('❌ Произошла ошибка при обработке вашего выбора.');
    }
  }
};

async function processConversationState(
  ctx: Context, 
  telegramId: number, 
  text: string, 
  state: any
): Promise<void> {
  const dbUser = await storage.getUserByTelegramId(String(telegramId));
  if (!dbUser) return;

  switch (state.command) {
    case 'digest_add':
      await handleDigestAdd(ctx, telegramId, text, state, dbUser.id);
      break;
      
    case 'digest_edit':
      await handleDigestEdit(ctx, telegramId, text, state);
      break;
      
    case 'digest_delete':
      await handleDigestDelete(ctx, telegramId, text, state);
      break;
      
    case 'channel_add':
      await handleChannelAdd(ctx, telegramId, text, state);
      break;
      
    case 'summary_model':
      await handleSummaryModel(ctx, telegramId, text, state, dbUser.id);
      break;
  }
}

async function handleDigestAdd(
  ctx: Context, 
  telegramId: number, 
  text: string, 
  state: any, 
  userId: string
): Promise<void> {
  switch (state.step) {
    case 'name':
      const name = text.trim();
      if (!DIGEST_NAME_PATTERN.test(name)) {
        await ctx.reply('❌ Имя должно содержать 2–50 букв, цифр, пробелов, дефисов или подчёркиваний. Попробуйте еще раз:');
        return;
      }

      setConversationState(telegramId, {
        ...state,
        step: 'frequency',
        name
      });

      const keyboard = createFrequencyKeyboard();
      await ctx.reply(`📅 <b>Периодичность дайджеста "${name}"</b>

Выберите периодичность:

1️⃣ Ежедневно - каждый день в указанное время
2️⃣ Еженедельно - один раз в неделю в указанный день

Выберите кнопку или введите 1 или 2:`, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      break;

    case 'frequency':
      const freqChoice = text.trim();
      let frequency: 'daily' | 'weekly';
      
      if (freqChoice === '1') {
        frequency = 'daily';
      } else if (freqChoice === '2') {
        frequency = 'weekly';
      } else {
        await ctx.reply('❌ Введите 1 для ежедневно или 2 для еженедельно:');
        return;
      }

      const newState = {
        ...state,
        step: frequency === 'weekly' ? 'weekday' : 'time',
        frequency
      };

      setConversationState(telegramId, newState);

      if (frequency === 'weekly') {
        await ctx.reply(`📆 <b>День недели для "${state.name}"</b>

Выберите день недели:

1️⃣ Понедельник
2️⃣ Вторник  
3️⃣ Среда
4️⃣ Четверг
5️⃣ Пятница
6️⃣ Суббота
7️⃣ Воскресенье

Введите номер дня:`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`🕐 <b>Время отправки "${state.name}"</b>

Введите время в формате ЧЧ:ММ (например: 09:00, 18:30):

<i>Время будет использоваться в вашем часовом поясе</i>`, { parse_mode: 'HTML' });
      }
      break;

    case 'weekday':
      const dayChoice = parseInt(text.trim());
      if (dayChoice < 1 || dayChoice > 7 || isNaN(dayChoice)) {
        await ctx.reply('❌ Введите номер от 1 до 7:');
        return;
      }

      // Convert to Sunday=0 format (1=Monday -> 1, 7=Sunday -> 0)
      const weekday = dayChoice === 7 ? 0 : dayChoice;

      setConversationState(telegramId, {
        ...state,
        step: 'time',
        weekday
      });

      await ctx.reply(`🕐 <b>Время отправки "${state.name}"</b>

Введите время в формате ЧЧ:ММ (например: 09:00, 18:30):

<i>Время будет использоваться в вашем часовом поясе</i>`, { parse_mode: 'HTML' });
      break;

    case 'time':
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
      const timeMatch = text.trim().match(timeRegex);
      
      if (!timeMatch) {
        await ctx.reply('❌ Неверный формат времени. Используйте ЧЧ:ММ (например: 09:00):');
        return;
      }

      const localTime = text.trim();
      
      setConversationState(telegramId, {
        ...state,
        step: 'confirm',
        localTime
      });

      const user = await storage.getUser(userId);
      const freqText = state.frequency === 'daily' ? 'ежедневно' : 'еженедельно';
      const weekdayNames = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
      const weekdayText = state.weekday !== undefined ? ` по ${weekdayNames[state.weekday]}ам` : '';

      const confirmKeyboard = createConfirmationKeyboard();
      await ctx.reply(`✅ <b>Подтверждение создания дайджеста</b>

<b>Имя:</b> ${state.name}
<b>Периодичность:</b> ${freqText}${weekdayText}
<b>Время:</b> ${localTime} (${user?.timezone || 'UTC'})

Все верно? Нажмите кнопку или введите "ДА" для создания или "НЕТ" для отмены:`, { 
        parse_mode: 'HTML',
        reply_markup: confirmKeyboard
      });
      break;

    case 'confirm':
      const confirmation = text.trim().toLowerCase();
      
      if (confirmation === 'да' || confirmation === 'yes') {
        try {
          const digest = await userService.createDigest(userId, {
            name: state.name,
            frequency: state.frequency,
            localTime: state.localTime,
            weekday: state.weekday
          });

          clearConversationState(telegramId);

          const keyboard = createDigestCreatedKeyboard(digest.name);
          await ctx.reply(`🎉 <b>Дайджест создан!</b>

Дайджест "${digest.name}" успешно создан и запланирован.

<b>Следующий шаг:</b>
Добавьте каналы: <code>/channel_add ${digest.name}</code>

Посмотреть все дайджесты: /digest_list`, { 
            parse_mode: 'HTML',
            reply_markup: keyboard
          });

        } catch (error) {
          clearConversationState(telegramId);
          await ctx.reply(`❌ Ошибка при создании дайджеста: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
        }
      } else if (confirmation === 'нет' || confirmation === 'no') {
        clearConversationState(telegramId);
        await ctx.reply('❌ Создание дайджеста отменено.');
      } else {
        // Don't clear state, ask again
        const confirmKeyboard = createConfirmationKeyboard();
        await ctx.reply(`⚠️ Пожалуйста, нажмите кнопку или введите "ДА" для создания или "НЕТ" для отмены:`, {
          reply_markup: confirmKeyboard
        });
      }
      break;
  }
}

async function handleDigestEdit(
  ctx: Context, 
  telegramId: number, 
  text: string, 
  state: any
): Promise<void> {
  const choice = text.trim();

  switch (state.step) {
    case 'menu':
      if (!['1', '2', '3', '4', '5'].includes(choice)) {
        await ctx.reply('❌ Введите номер от 1 до 5:');
        return;
      }

      const digest = await storage.getDigest(state.digestId);
      if (!digest) {
        clearConversationState(telegramId);
        await ctx.reply('❌ Дайджест не найден.');
        return;
      }

      switch (choice) {
        case '1': // Edit name
          setConversationState(telegramId, {
            ...state,
            step: 'edit_name'
          });
          await ctx.reply(`📝 Введите новое имя для дайджеста (текущее: "${digest.name}"):`);
          break;

        case '2': // Edit time
          setConversationState(telegramId, {
            ...state,
            step: 'edit_time'
          });
          await ctx.reply(`🕐 Введите новое время в формате ЧЧ:ММ (текущее: ${digest.localTime}):`);
          break;

        case '3': // Edit frequency
          setConversationState(telegramId, {
            ...state,
            step: 'edit_frequency'
          });
          await ctx.reply(`📅 Выберите новую периодичность:

1️⃣ Ежедневно
2️⃣ Еженедельно

Текущая: ${digest.frequency === 'daily' ? 'ежедневно' : 'еженедельно'}

Введите 1 или 2:`);
          break;

        case '4': // Toggle active
          const newActiveStatus = !digest.isActive;
          await storage.updateDigest(state.digestId, { isActive: newActiveStatus });
          
          if (newActiveStatus) {
            await schedulerService.scheduleDigest(state.digestId);
          } else {
            await schedulerService.unscheduleDigest(state.digestId);
          }

          clearConversationState(telegramId);
          await ctx.reply(`✅ Дайджест "${digest.name}" ${newActiveStatus ? 'активирован' : 'приостановлен'}.`);
          break;

        case '5': // Delete digest
          setConversationState(telegramId, {
            ...state,
            step: 'confirm_delete'
          });
          
          const confirmKeyboard = createConfirmationKeyboard();
          await ctx.reply(`⚠️ <b>Подтверждение удаления</b>

Вы уверены, что хотите удалить дайджест "<b>${digest.name}</b>"?

Это действие нельзя отменить. Будут удалены:
• Дайджест и его настройки
• Связи с каналами
• История запусков

Нажмите кнопку или введите "ДА" для подтверждения или "НЕТ" для отмены:`, { 
            parse_mode: 'HTML',
            reply_markup: confirmKeyboard
          });
          break;
      }
      break;

    case 'edit_name':
      const newName = text.trim();
      if (!DIGEST_NAME_PATTERN.test(newName)) {
        await ctx.reply('❌ Имя должно содержать 2–50 букв, цифр, пробелов, дефисов или подчёркиваний. Попробуйте еще раз:');
        return;
      }

      await storage.updateDigest(state.digestId, { name: newName });
      clearConversationState(telegramId);
      await ctx.reply(`✅ Имя дайджеста изменено на "${newName}".`);
      break;

    case 'edit_time':
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
      if (!timeRegex.test(text.trim())) {
        await ctx.reply('❌ Неверный формат времени. Используйте ЧЧ:ММ (например: 09:00):');
        return;
      }

      await storage.updateDigest(state.digestId, { localTime: text.trim() });
      await schedulerService.scheduleDigest(state.digestId);
      
      clearConversationState(telegramId);
      await ctx.reply(`✅ Время дайджеста изменено на ${text.trim()}.`);
      break;

    case 'edit_frequency':
      let newFrequency: 'daily' | 'weekly';
      
      if (choice === '1') {
        newFrequency = 'daily';
      } else if (choice === '2') {
        newFrequency = 'weekly';
      } else {
        await ctx.reply('❌ Введите 1 для ежедневно или 2 для еженедельно:');
        return;
      }

      if (newFrequency === 'weekly') {
        setConversationState(telegramId, {
          ...state,
          step: 'edit_weekday',
          newFrequency
        });

        await ctx.reply(`📆 Выберите день недели:

1️⃣ Понедельник
2️⃣ Вторник  
3️⃣ Среда
4️⃣ Четверг
5️⃣ Пятница
6️⃣ Суббота
7️⃣ Воскресенье

Введите номер дня:`);
      } else {
        await storage.updateDigest(state.digestId, { 
          frequency: newFrequency,
          weekday: null 
        });
        await schedulerService.scheduleDigest(state.digestId);
        
        clearConversationState(telegramId);
        await ctx.reply(`✅ Периодичность изменена на "${newFrequency === 'daily' ? 'ежедневно' : 'еженедельно'}".`);
      }
      break;

    case 'edit_weekday':
      const dayChoice = parseInt(text.trim());
      if (dayChoice < 1 || dayChoice > 7 || isNaN(dayChoice)) {
        await ctx.reply('❌ Введите номер от 1 до 7:');
        return;
      }

      const weekday = dayChoice === 7 ? 0 : dayChoice;

      await storage.updateDigest(state.digestId, { 
        frequency: state.newFrequency,
        weekday 
      });
      await schedulerService.scheduleDigest(state.digestId);
      
      clearConversationState(telegramId);
      await ctx.reply(`✅ Периодичность изменена на "еженедельно".`);
      break;

    case 'confirm_delete':
      const deleteConfirmation = text.trim().toLowerCase();
      
      if (deleteConfirmation === 'да' || deleteConfirmation === 'yes') {
        try {
          const digestToDelete = await storage.getDigest(state.digestId);
          await schedulerService.unscheduleDigest(state.digestId);
          await storage.deleteDigest(state.digestId);
          
          clearConversationState(telegramId);
          await ctx.reply(`✅ Дайджест "${digestToDelete?.name || state.digestName}" удален.`);
          
        } catch (error) {
          clearConversationState(telegramId);
          await ctx.reply(`❌ Ошибка при удалении: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
        }
      } else if (deleteConfirmation === 'нет' || deleteConfirmation === 'no') {
        clearConversationState(telegramId);
        await ctx.reply('❌ Удаление отменено.');
      } else {
        // Don't clear state, ask again
        const confirmKeyboard = createConfirmationKeyboard();
        await ctx.reply(`⚠️ Пожалуйста, нажмите кнопку или введите "ДА" для подтверждения или "НЕТ" для отмены:`, {
          reply_markup: confirmKeyboard
        });
      }
      break;
  }
}

async function handleDigestDelete(
  ctx: Context, 
  telegramId: number, 
  text: string, 
  state: any
): Promise<void> {
  const confirmation = text.trim().toLowerCase();
  
  if (confirmation === 'да' || confirmation === 'yes') {
    try {
      await schedulerService.unscheduleDigest(state.digestId);
      await storage.deleteDigest(state.digestId);
      
      clearConversationState(telegramId);
      await ctx.reply(`✅ Дайджест "${state.digestName}" удален.`);
      
    } catch (error) {
      clearConversationState(telegramId);
      await ctx.reply(`❌ Ошибка при удалении: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
    }
  } else {
    clearConversationState(telegramId);
    await ctx.reply('❌ Удаление отменено.');
  }
}

async function handleChannelAdd(
  ctx: Context, 
  telegramId: number, 
  text: string, 
  state: any
): Promise<void> {
  const channels = text.trim().split(/\s+/).filter(ch => ch.length > 0);
  
  if (channels.length === 0) {
    await ctx.reply('❌ Введите хотя бы один канал.');
    return;
  }

  if (channels.length > 20) {
    await ctx.reply('❌ Можно добавить максимум 20 каналов за раз.');
    return;
  }

  await ctx.reply(`⏳ Проверяю каналы и добавляю их в дайджест...`);

  const results = {
    added: [] as string[],
    failed: [] as Array<{ channel: string; error: string }>
  };

  for (const channel of channels) {
    try {
      await userService.addChannelToDigest(state.digestId, channel);
      results.added.push(channel);
    } catch (error) {
      results.failed.push({
        channel,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка'
      });
    }
  }

  let message = `📡 <b>Результаты добавления каналов в "${state.digestName}":</b>\n\n`;

  if (results.added.length > 0) {
    message += `✅ <b>Успешно добавлены (${results.added.length}):</b>\n`;
    results.added.forEach(ch => {
      message += `• ${ch}\n`;
    });
    message += '\n';
  }

  if (results.failed.length > 0) {
    message += `❌ <b>Не удалось добавить (${results.failed.length}):</b>\n`;
    results.failed.forEach(({ channel, error }) => {
      message += `• ${channel}: ${error}\n`;
    });
  }

  if (results.added.length > 0) {
    message += `\n<b>Что дальше?</b>
• Просмотр каналов: <code>/channel_list ${state.digestName}</code>
• Тестовый запуск: <code>/test_run ${state.digestName}</code>`;
  }

  clearConversationState(telegramId);
  
  const keyboard = results.added.length > 0 ? createChannelsAddedKeyboard(state.digestName) : undefined;
  await ctx.reply(message, { 
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function handleSummaryModel(
  ctx: Context, 
  telegramId: number, 
  text: string, 
  state: any,
  userId: string
): Promise<void> {
  const choice = text.trim();

  switch (state.step) {
    case 'menu':
      if (!['1', '2', '3', '4'].includes(choice)) {
        await ctx.reply('❌ Введите номер от 1 до 4:');
        return;
      }

      switch (choice) {
        case '1': // Model
          setConversationState(telegramId, {
            ...state,
            step: 'model'
          });
          await ctx.reply(`🤖 Выберите модель OpenAI:

1️⃣ GPT-6 Luna (effort: low)
2️⃣ GPT-6 Sol (effort: medium)

Введите номер модели:`);
          break;

        case '2': // Length
          setConversationState(telegramId, {
            ...state,
            step: 'length'
          });
          await ctx.reply(`📏 Выберите длину сводки:

1️⃣ Короткая (400-600 слов)
2️⃣ Средняя (600-900 слов)
3️⃣ Длинная (900-1200 слов)

Введите номер:`);
          break;

        case '3': // Temperature
          setConversationState(telegramId, {
            ...state,
            step: 'temperature'
          });
          await ctx.reply(`🎨 Введите температуру (креативность) от 0.0 до 1.0:

• 0.0-0.3 - консервативно, фактично
• 0.4-0.6 - сбалансированно  
• 0.7-1.0 - креативно, разнообразно

Текущее значение можно посмотреть в /summary_model`);
          break;

        case '4': // Max tokens
          setConversationState(telegramId, {
            ...state,
            step: 'tokens'
          });
          await ctx.reply(`🔢 Введите максимальное количество токенов (500-4000):

• 500-1000 - короткие сводки
• 1000-2000 - стандартные сводки
• 2000-4000 - длинные детальные сводки

Больше токенов = больше расход лимитов.`);
          break;
      }
      break;

    case 'model':
      const modelMap: Record<string, string> = {
        '1': 'gpt-6-luna',
        '2': 'gpt-6-sol'
      };

      const model = modelMap[choice];
      if (!model) {
        await ctx.reply('❌ Введите номер 1 или 2:');
        return;
      }

      await storage.updateUserSettings(userId, { openaiModel: model });
      clearConversationState(telegramId);
      await ctx.reply(`✅ Модель изменена на ${model}.`);
      break;

    case 'length':
      const lengthMap: Record<string, string> = {
        '1': 'short',
        '2': 'medium',
        '3': 'long'
      };

      const length = lengthMap[choice];
      if (!length) {
        await ctx.reply('❌ Введите номер от 1 до 3:');
        return;
      }

      await storage.updateUserSettings(userId, { summaryLength: length });
      clearConversationState(telegramId);
      await ctx.reply(`✅ Длина сводки изменена.`);
      break;

    case 'temperature':
      const temp = parseFloat(text);
      if (isNaN(temp) || temp < 0 || temp > 1) {
        await ctx.reply('❌ Введите число от 0.0 до 1.0:');
        return;
      }

      await storage.updateUserSettings(userId, { temperature: temp.toString() });
      clearConversationState(telegramId);
      await ctx.reply(`✅ Температура изменена на ${temp}.`);
      break;

    case 'tokens':
      const tokens = parseInt(text);
      if (isNaN(tokens) || tokens < 500 || tokens > 4000) {
        await ctx.reply('❌ Введите число от 500 до 4000:');
        return;
      }

      await storage.updateUserSettings(userId, { maxTokens: tokens });
      clearConversationState(telegramId);
      await ctx.reply(`✅ Максимальное количество токенов изменено на ${tokens}.`);
      break;
  }
}
