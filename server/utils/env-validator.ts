import {
  allowAllUsers,
  getAdminTelegramIds,
  getAllowedTelegramIds,
} from "./access-control.js";
import { logger } from "./logger.js";

type ValidationResult = {
  isValid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateEnvironment(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of ["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "DATABASE_URL"] as const) {
    if (!process.env[key]) errors.push(`${key} is required`);
  }

  const allowedCount = getAllowedTelegramIds().size;
  const adminCount = getAdminTelegramIds().size;

  if (!allowAllUsers() && allowedCount === 0 && adminCount === 0) {
    errors.push(
      "Set ALLOWED_TELEGRAM_IDS or ADMIN_TELEGRAM_IDS, or explicitly set ALLOW_ALL_USERS=true",
    );
  }

  if (allowAllUsers()) {
    warnings.push(
      "ALLOW_ALL_USERS is enabled; any Telegram user can consume your OpenAI quota",
    );
  }

  return { isValid: errors.length === 0, errors, warnings };
}

export function enforceEnvironmentSafety(): void {
  const validation = validateEnvironment();

  if (validation.warnings.length > 0) {
    logger.warn("Environment warnings", { warnings: validation.warnings });
  }

  if (!validation.isValid) {
    logger.error("Invalid environment configuration", {
      errors: validation.errors,
    });
    throw new Error(validation.errors.join("; "));
  }
}
