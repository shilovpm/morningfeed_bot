import { Context } from 'telegraf';
import { storage } from '../storage.js';
import { userService } from '../services/user.js';
import { schedulerService } from '../services/scheduler.js';
import { validateTimezone } from '../utils/timezone.js';
import { logger } from '../utils/logger.js';
import { createStartKeyboard, createDigestListKeyboard, createDigestEditKeyboard, createTimezoneQuickSelectKeyboard, createChannelListKeyboard, createInlineKeyboard } from './inline-keyboard.js';
import { escapeTelegramText } from '../utils/telegram-html.js';

const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const MAX_CONVERSATION_STATES = 10_000;
const conversationStates = new Map<number, { value: any; expiresAt: number }>();

function setConversationState(telegramId: number, state: any): void {
  if (!conversationStates.has(telegramId) && conversationStates.size >= MAX_CONVERSATION_STATES) {
    const oldestKey = conversationStates.keys().next().value;
    if (oldestKey !== undefined) conversationStates.delete(oldestKey);
  }
  conversationStates.set(telegramId, {
    value: state,
    expiresAt: Date.now() + CONVERSATION_TTL_MS,
  });
}

function getConversationState(telegramId: number): any {
  const entry = conversationStates.get(telegramId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    conversationStates.delete(telegramId);
    return undefined;
  }
  return entry.value;
}

function clearConversationState(telegramId: number): void {
  conversationStates.delete(telegramId);
}

export const commandHandlers = {
  async start(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await userService.getOrCreateUser(user);
    
    const welcomeMessage = `👋 Добро пожаловать в Morning Feed Bot!

Я помогу вам создавать автоматические сводки новостей из Telegram-каналов с помощью ИИ.

🔧 <b>Что умею:</b>
• Создавать несколько дайджестов с разным расписанием
• Собирать посты из ваших любимых каналов
• Генерировать умные сводки через OpenAI
• Работать с разными часовыми поясами

📅 <b>Начните с настройки:</b>
1. /timezone - установите часовой пояс
2. /digest_add - создайте первый дайджест
3. /channel_add - добавьте каналы для мониторинга

Нажмите /help для списка всех команд.`;

    const keyboard = createStartKeyboard();
    await ctx.reply(welcomeMessage, { 
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  },

  async help(ctx: Context): Promise<void> {
    const helpMessage = `🤖 <b>Morning Feed Bot - Справка</b>

<b>📋 Управление дайджестами:</b>
/digest_add - создать новый дайджест
/digest_list - список ваших дайджестов
/digest_edit [имя] - редактировать дайджест
/digest_delete [имя] - удалить дайджест

<b>📡 Управление каналами:</b>
/channel_add [имя дайджеста] - добавить каналы
/channel_list [имя дайджеста] - показать каналы дайджеста
/channel_remove [имя дайджеста] [канал] - удалить канал

<b>⚙️ Настройки:</b>
/timezone - настроить часовой пояс

<b>🔧 Тестирование:</b>
/test_run [имя дайджеста] - принудительно создать сводку

<b>Примеры:</b>
• <code>/digest_add</code> - мастер создания
• <code>/channel_add Новости</code> - добавить каналы в дайджест "Новости"
• <code>/test_run Новости</code> - тест дайджеста "Новости"`;

    await ctx.reply(helpMessage, { parse_mode: 'HTML' });
  },

  async timezone(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      const currentUser = await storage.getUserByTelegramId(String(user.id));
      const currentTz = currentUser?.timezone || 'UTC';
      
      const timezoneMessage = `🌍 <b>Настройка часового пояса</b>

Текущий часовой пояс: <code>${currentTz}</code>

Выберите часовой пояс из популярных или отправьте команду:
<code>/timezone IANA_TIMEZONE</code>

<b>Примеры:</b>
• <code>/timezone Europe/Moscow</code>
• <code>/timezone Europe/Lisbon</code>
• <code>/timezone Europe/London</code>
• <code>/timezone America/New_York</code>
• <code>/timezone Asia/Tokyo</code>

Список всех поясов: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones`;

      const keyboard = createTimezoneQuickSelectKeyboard();
      await ctx.reply(timezoneMessage, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return;
    }

    const timezone = args[0];
    
    if (!validateTimezone(timezone)) {
      await ctx.reply(`❌ Неверный часовой пояс: ${timezone}\n\nИспользуйте формат IANA, например: Europe/Moscow`);
      return;
    }

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (dbUser) {
      await userService.updateUserTimezone(dbUser.id, timezone);
      await ctx.reply(`✅ Часовой пояс изменен на ${timezone}\n\nВсе ваши дайджесты будут перепланированы.`);
    }
  },

  async digestAdd(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    setConversationState(user.id, {
      command: 'digest_add',
      step: 'name'
    });

    await ctx.reply(`📝 <b>Создание нового дайджеста</b>

Как назовем дайджест? Введите имя (например: "Новости", "Tech Daily", "Криптовалюты"):`, 
      { parse_mode: 'HTML' }
    );
  },

  async digestList(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    
    if (digests.length === 0) {
      await ctx.reply(`📭 У вас пока нет дайджестов.

Создайте первый дайджест командой /digest_add`);
      return;
    }

    let message = `📋 <b>Ваши дайджесты (${digests.length}):</b>\n\n`;
    
    for (const digest of digests) {
      const channels = await storage.getDigestChannels(digest.id);
      const statusIcon = digest.isActive ? '✅' : '⏸';
      const lastRun = digest.lastRunAt 
        ? new Date(digest.lastRunAt).toLocaleString('ru-RU')
        : 'никогда';

      message += `${statusIcon} <b>${digest.name}</b>
📅 ${digest.frequency === 'daily' ? 'Ежедневно' : 'Еженедельно'} в ${digest.localTime}
📡 Каналов: ${channels.length}
⏱ Последний запуск: ${lastRun}

`;
    }

    message += `<b>Команды:</b>
• /digest_edit [имя] - редактировать
• /digest_delete [имя] - удалить
• /channel_add [имя] - добавить каналы
• /test_run [имя] - тестовый запуск`;

    const keyboard = createDigestListKeyboard(
      digests.length,
      digests.length === 1 ? digests[0].name : undefined
    );
    await ctx.reply(message, { 
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  },

  async digestEdit(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      // Show list of digests to choose from
      const dbUser = await storage.getUserByTelegramId(String(user.id));
      if (!dbUser) return;

      const digests = await storage.getUserDigests(dbUser.id);
      
      if (digests.length === 0) {
        await ctx.reply(`📭 У вас пока нет дайджестов.

Создайте первый дайджест командой /digest_add`);
        return;
      }

      let message = `✏️ <b>Выберите дайджест для редактирования:</b>\n\n`;
      
      const buttons = digests.map(digest => ({
        text: `${digest.isActive ? '✅' : '⏸'} ${digest.name}`,
        callbackData: `/digest_edit ${digest.name}`
      }));

      const keyboard = createInlineKeyboard(buttons, 2);
      await ctx.reply(message, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return;
    }

    const digestName = args.join(' ');
    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    const digest = digests.find(d => d.name.toLowerCase() === digestName.toLowerCase());
    
    if (!digest) {
      await ctx.reply(`❌ Дайджест "${digestName}" не найден.`);
      return;
    }

    setConversationState(user.id, {
      command: 'digest_edit',
      digestId: digest.id,
      digestName: digest.name,
      step: 'menu'
    });

    const keyboard = createDigestEditKeyboard();
    await ctx.reply(`⚙️ <b>Редактирование "${digest.name}"</b>

Что хотите изменить?

1️⃣ Имя дайджеста
2️⃣ Время отправки (сейчас: ${digest.localTime})
3️⃣ Периодичность (сейчас: ${digest.frequency === 'daily' ? 'ежедневно' : 'еженедельно'})
4️⃣ ${digest.isActive ? 'Приостановить' : 'Активировать'}
5️⃣ Удалить навсегда

Выберите кнопку или введите номер пункта:`, { 
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  },

  async digestDelete(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      // Show list of digests to choose from
      const dbUser = await storage.getUserByTelegramId(String(user.id));
      if (!dbUser) return;

      const digests = await storage.getUserDigests(dbUser.id);
      
      if (digests.length === 0) {
        await ctx.reply(`📭 У вас пока нет дайджестов.

Создайте первый дайджест командой /digest_add`);
        return;
      }

      let message = `🗑 <b>Выберите дайджест для удаления:</b>\n\n`;
      
      const buttons = digests.map(digest => ({
        text: `${digest.isActive ? '✅' : '⏸'} ${digest.name}`,
        callbackData: `/digest_delete ${digest.name}`
      }));

      const keyboard = createInlineKeyboard(buttons, 2);
      await ctx.reply(message, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return;
    }

    const digestName = args.join(' ');
    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    const digest = digests.find(d => d.name.toLowerCase() === digestName.toLowerCase());
    
    if (!digest) {
      await ctx.reply(`❌ Дайджест "${digestName}" не найден.`);
      return;
    }

    setConversationState(user.id, {
      command: 'digest_delete',
      digestId: digest.id,
      digestName: digest.name
    });

    await ctx.reply(`⚠️ <b>Подтверждение удаления</b>

Вы уверены, что хотите удалить дайджест "<b>${digest.name}</b>"?

Это действие нельзя отменить. Будут удалены:
• Дайджест и его настройки
• Связи с каналами
• История запусков

Введите "ДА" для подтверждения или любой другой текст для отмены:`, { parse_mode: 'HTML' });
  },

  async channelAdd(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      // Show list of digests to choose from
      const dbUser = await storage.getUserByTelegramId(String(user.id));
      if (!dbUser) return;

      const digests = await storage.getUserDigests(dbUser.id);
      
      if (digests.length === 0) {
        await ctx.reply(`📭 У вас пока нет дайджестов.

Создайте первый дайджест командой /digest_add`);
        return;
      }

      let message = `📡 <b>Выберите дайджест для добавления каналов:</b>\n\n`;
      
      const buttons = digests.map(digest => ({
        text: `${digest.isActive ? '✅' : '⏸'} ${digest.name}`,
        callbackData: `/channel_add ${digest.name}`
      }));

      const keyboard = createInlineKeyboard(buttons, 2);
      await ctx.reply(message, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return;
    }

    const digestName = args.join(' ');
    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    const digest = digests.find(d => d.name.toLowerCase() === digestName.toLowerCase());
    
    if (!digest) {
      await ctx.reply(`❌ Дайджест "${digestName}" не найден.`);
      return;
    }

    setConversationState(user.id, {
      command: 'channel_add',
      digestId: digest.id,
      digestName: digest.name
    });

    await ctx.reply(`📡 <b>Добавление каналов в "${digest.name}"</b>

Введите usernames каналов через пробел.

<b>Формат:</b> @channel1 @channel2 @channel3

<b>Примеры:</b>
• @techcrunch @theverge @coindesk
• @durov @telegram @news

<b>Важно:</b>
• Каналы должны быть публичными
• Бот должен иметь доступ к истории сообщений
• Можно добавить до 20 каналов за раз
• Общего лимита на количество каналов в дайджесте нет`, { parse_mode: 'HTML' });
  },

  async channelList(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      await ctx.reply(`❌ Укажите имя дайджеста для просмотра каналов.

Пример: <code>/channel_list Новости</code>`, { parse_mode: 'HTML' });
      return;
    }

    const digestName = args.join(' ');
    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    const digest = digests.find(d => d.name.toLowerCase() === digestName.toLowerCase());
    
    if (!digest) {
      await ctx.reply(`❌ Дайджест "${digestName}" не найден.`);
      return;
    }

    const channels = await storage.getDigestChannels(digest.id);
    
    if (channels.length === 0) {
      await ctx.reply(`📭 В дайджесте "${digest.name}" нет каналов.

Добавьте каналы командой:
<code>/channel_add ${digest.name}</code>`, { parse_mode: 'HTML' });
      return;
    }

    let message = `📡 <b>Каналы дайджеста "${digest.name}" (${channels.length}):</b>\n\n`;
    
    channels.forEach((channel, index) => {
      const statusIcon = channel.isActive ? '✅' : '❌';
      message += `${index + 1}. ${statusIcon} ${channel.username}`;
      if (channel.title) {
        message += ` - ${escapeTelegramText(channel.title)}`;
      }
      message += '\n';
    });

    message += `\nВыберите канал для удаления или используйте команду:
<code>/channel_remove ${digest.name} @канал</code>`;

    const keyboard = createChannelListKeyboard(digest.id, channels);
    await ctx.reply(message, { 
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  },

  async channelRemove(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length < 2) {
      await ctx.reply(`❌ Укажите имя дайджеста и канал для удаления.

Пример: <code>/channel_remove Новости @techcrunch</code>`, { parse_mode: 'HTML' });
      return;
    }

    const channelUsername = args.pop(); // Last argument is channel
    const digestName = args.join(' '); // Everything else is digest name
    
    if (!channelUsername) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    const digest = digests.find(d => d.name.toLowerCase() === digestName.toLowerCase());
    
    if (!digest) {
      await ctx.reply(`❌ Дайджест "${digestName}" не найден.`);
      return;
    }

    try {
      await userService.removeChannelFromDigest(digest.id, channelUsername);
      await ctx.reply(`✅ Канал ${channelUsername} удален из дайджеста "${digest.name}".`);
    } catch (error) {
      await ctx.reply(`❌ ${error instanceof Error ? error.message : 'Ошибка при удалении канала'}`);
    }
  },

  async testRun(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      // Show list of digests to choose from
      const dbUser = await storage.getUserByTelegramId(String(user.id));
      if (!dbUser) return;

      const digests = await storage.getUserDigests(dbUser.id);
      
      if (digests.length === 0) {
        await ctx.reply(`📭 У вас пока нет дайджестов.

Создайте первый дайджест командой /digest_add`);
        return;
      }

      let message = `🧪 <b>Выберите дайджест для тестового запуска:</b>\n\n`;
      
      const buttons = digests.map(digest => ({
        text: `${digest.isActive ? '✅' : '⏸'} ${digest.name}`,
        callbackData: `/test_run ${digest.name}`
      }));

      const keyboard = createInlineKeyboard(buttons, 2);
      await ctx.reply(message, { 
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
      return;
    }

    const digestName = args.join(' ');
    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const digests = await storage.getUserDigests(dbUser.id);
    const digest = digests.find(d => d.name.toLowerCase() === digestName.toLowerCase());
    
    if (!digest) {
      await ctx.reply(`❌ Дайджест "${digestName}" не найден.`);
      return;
    }

    await ctx.reply(`⏳ Запускаю тестовый дайджест "${digest.name}"...\n\nЭто может занять несколько минут.`);

    try {
      await schedulerService.executeDigestManually(digest.id);
      
      // Simple success confirmation - the main process handles sending the digest
      await ctx.reply(`✅ Тестовый дайджест "${digest.name}" выполнен! Результат отправлен в чат.`);
      
    } catch (error) {
      logger.error('Manual test run failed', {
        digestId: digest.id,
        userId: dbUser.id,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      
      await ctx.reply('❌ Тестовый запуск завершился ошибкой. Подробности сохранены в журнале оператора.');
    }
  },

  async summaryModel(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser) return;

    const settings = await storage.getUserSettings(dbUser.id);
    
    if (!settings) {
      await ctx.reply('❌ Настройки не найдены.');
      return;
    }

    setConversationState(user.id, {
      command: 'summary_model',
      step: 'menu'
    });

    const modelNames: Record<string, string> = {
      'gpt-6-luna': 'GPT-6 Luna (effort: low)',
      'gpt-6-sol': 'GPT-6 Sol (effort: medium)'
    };

    const lengthNames: Record<string, string> = {
      'short': 'Короткая (400-600 слов)',
      'medium': 'Средняя (600-900 слов)', 
      'long': 'Длинная (900-1200 слов)'
    };

    const message = `🤖 <b>Настройки ИИ-модели</b>

<b>Текущие настройки:</b>
• Модель: ${settings.openaiModel ? (modelNames[settings.openaiModel] || settings.openaiModel) : 'не установлено'}
• Длина сводки: ${settings.summaryLength ? (lengthNames[settings.summaryLength] || settings.summaryLength) : 'не установлено'}
• Температура: ${settings.temperature} (креативность)
• Макс. токенов: ${settings.maxTokens}

<b>Что изменить?</b>
1️⃣ Модель OpenAI
2️⃣ Длина сводки
3️⃣ Температура (0.0-1.0)
4️⃣ Максимум токенов

Введите номер пункта:`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  },

  // Admin commands
  async stats(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser?.isAdmin) {
      await ctx.reply('❌ Эта команда доступна только администраторам.');
      return;
    }

    const stats = await storage.getSystemStats();
    
    const message = `📊 <b>Статистика системы</b>

👥 Всего пользователей: ${stats.totalUsers}
📋 Активных дайджестов: ${stats.activeDigests}
📡 Каналов мониторинга: ${stats.monitoredChannels}
📄 Обработано постов: ${stats.postsProcessed}
🤖 Использовано токенов: ${stats.tokensUsed.toLocaleString()}
🔄 Запусков сегодня: ${stats.dailyRuns}
❌ Процент ошибок: ${stats.errorRate.toFixed(1)}%

⏰ Активных задач планировщика: ${schedulerService.getActiveTasksCount()}`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  },

  async errorsLast(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser?.isAdmin) {
      await ctx.reply('❌ Эта команда доступна только администраторам.');
      return;
    }

    const errors = await storage.getRecentErrors(10);
    
    if (errors.length === 0) {
      await ctx.reply('✅ За последнее время ошибок не было.');
      return;
    }

    let message = `❌ <b>Последние ошибки (${errors.length}):</b>\n\n`;
    
    errors.forEach((run, index) => {
      const time = run.createdAt ? new Date(run.createdAt).toLocaleString('ru-RU') : 'неизвестно';
      message += `${index + 1}. <b>${time}</b>\n`;
      message += `Дайджест ID: ${run.digestId}\n`;
      message += `Ошибка: ${escapeTelegramText(run.errorMessage || 'Неизвестная ошибка')}\n\n`;
    });

    await ctx.reply(message, { parse_mode: 'HTML' });
  },

  async userInfo(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser?.isAdmin) {
      await ctx.reply('❌ Эта команда доступна только администраторам.');
      return;
    }

    const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
    
    if (args.length === 0) {
      await ctx.reply('❌ Укажите Telegram ID пользователя.\n\nПример: <code>/user 123456789</code>', { parse_mode: 'HTML' });
      return;
    }

    const telegramId = parseInt(args[0]);
    if (isNaN(telegramId)) {
      await ctx.reply('❌ Неверный формат Telegram ID.');
      return;
    }

    const targetUser = await storage.getUserByTelegramId(String(telegramId));
    if (!targetUser) {
      await ctx.reply('❌ Пользователь не найден.');
      return;
    }

    const stats = await userService.getUserStats(targetUser.id);
    const digests = await storage.getUserDigests(targetUser.id);

    const message = `👤 <b>Информация о пользователе</b>

<b>Основное:</b>
• ID: ${targetUser.telegramId}
• Имя: ${escapeTelegramText(targetUser.firstName || 'Не указано')} ${escapeTelegramText(targetUser.lastName || '')}
• Username: ${targetUser.username ? '@' + escapeTelegramText(targetUser.username) : 'Не указан'}
• План: ${escapeTelegramText(targetUser.plan)}
• Админ: ${targetUser.isAdmin ? 'Да' : 'Нет'}

<b>Настройки:</b>
• Часовой пояс: ${escapeTelegramText(targetUser.timezone)}
• Язык: ${escapeTelegramText(targetUser.languageCode || 'Не указан')}

<b>Статистика:</b>
• Дайджестов: ${stats.digestsCount}
• Каналов: ${stats.channelsCount}
• Токенов за месяц: ${stats.monthlyTokens.toLocaleString()} / ${stats.monthlyLimit.toLocaleString()}

<b>Дайджесты:</b>
${digests.map(d => `• ${escapeTelegramText(d.name)} (${escapeTelegramText(d.frequency)}, ${d.isActive ? 'активен' : 'неактивен'})`).join('\n') || 'Нет дайджестов'}

Регистрация: ${targetUser.createdAt ? new Date(targetUser.createdAt).toLocaleString('ru-RU') : 'неизвестно'}`;

    await ctx.reply(message, { parse_mode: 'HTML' });
  },

  async runsToday(ctx: Context): Promise<void> {
    const user = ctx.from;
    if (!user) return;

    const dbUser = await storage.getUserByTelegramId(String(user.id));
    if (!dbUser?.isAdmin) {
      await ctx.reply('❌ Эта команда доступна только администраторам.');
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const runs = await storage.getRunsInPeriod(today, tomorrow);
    
    const successRuns = runs.filter(r => r.status === 'success');
    const errorRuns = runs.filter(r => r.status === 'error');
    const emptyRuns = runs.filter(r => r.status === 'empty');

    let message = `📈 <b>Запуски за сегодня</b>

<b>Всего запусков:</b> ${runs.length}
• ✅ Успешных: ${successRuns.length}
• ❌ С ошибками: ${errorRuns.length}
• 📭 Пустых: ${emptyRuns.length}

<b>Статистика успешных:</b>
• Обработано постов: ${successRuns.reduce((sum, r) => sum + (r.postsCount || 0), 0)}
• Использовано токенов: ${successRuns.reduce((sum, r) => sum + (r.tokensUsed || 0), 0).toLocaleString()}`;

    if (errorRuns.length > 0) {
      message += `\n\n<b>Последние ошибки:</b>`;
      errorRuns.slice(-3).forEach((run, index) => {
        const time = run.createdAt ? new Date(run.createdAt).toLocaleString('ru-RU', { timeStyle: 'short' }) : 'неизвестно';
        message += `\n• ${time}: ${escapeTelegramText(run.errorMessage?.slice(0, 50) || 'Неизвестная ошибка')}...`;
      });
    }

    await ctx.reply(message, { parse_mode: 'HTML' });
  }
};

// Export helper functions for handlers
export { setConversationState, getConversationState, clearConversationState };
