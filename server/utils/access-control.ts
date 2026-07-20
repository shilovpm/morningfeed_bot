const TELEGRAM_ID_PATTERN = /^\d{1,20}$/;

export function parseTelegramIds(value: string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const item of (value || "").split(",")) {
    const id = item.trim();
    if (TELEGRAM_ID_PATTERN.test(id)) ids.add(id);
  }
  return ids;
}

export function allowAllUsers(): boolean {
  return ["true", "1", "yes"].includes(
    String(process.env.ALLOW_ALL_USERS || "").toLowerCase(),
  );
}

export function getAllowedTelegramIds(): Set<string> {
  return parseTelegramIds(process.env.ALLOWED_TELEGRAM_IDS);
}

export function getAdminTelegramIds(): Set<string> {
  return parseTelegramIds(process.env.ADMIN_TELEGRAM_IDS);
}

export function isTelegramAdmin(telegramId: string | number): boolean {
  return getAdminTelegramIds().has(String(telegramId));
}

export function isTelegramUserAllowed(telegramId: string | number): boolean {
  const id = String(telegramId);
  return (
    allowAllUsers() ||
    getAllowedTelegramIds().has(id) ||
    getAdminTelegramIds().has(id)
  );
}
