export function isPublishedApp(): boolean {
  const deployment = String(process.env.REPLIT_DEPLOYMENT || "").toLowerCase();
  return (
    process.env.NODE_ENV === "production" ||
    ["true", "1", "yes"].includes(deployment) ||
    Boolean(process.env.REPLIT_DEPLOYMENT_ID)
  );
}

export function envMode(): "production" | "development" {
  return isPublishedApp() ? "production" : "development";
}

export function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  return token;
}

export function isInlineCommandsEnabled(): boolean {
  return ["true", "1", "yes"].includes(
    String(process.env.INLINE_CMDS_ENABLED || "true").toLowerCase(),
  );
}
