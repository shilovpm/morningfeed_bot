import "dotenv/config";
import { createServer, type ServerResponse } from "node:http";
import { botService } from "./telegram/bot.js";
import { schedulerService } from "./services/scheduler.js";
import { watchdogService } from "./services/watchdog.js";
import { disconnectDatabase, initializeDatabase } from "./database.js";
import { enforceEnvironmentSafety } from "./utils/env-validator.js";
import { envMode } from "./utils/env.js";
import { logger } from "./utils/logger.js";

type ServiceState = "starting" | "ready" | "stopping";

let serviceState: ServiceState = "starting";
let shuttingDown = false;

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, serviceState === "ready" ? 200 : 503, {
      status: serviceState === "ready" ? "ok" : serviceState,
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.headersTimeout = 15_000;
server.requestTimeout = 10_000;
server.keepAliveTimeout = 5_000;

async function startServices(): Promise<void> {
  enforceEnvironmentSafety();
  await initializeDatabase();
  await schedulerService.initialize();
  await watchdogService.initialize();
  await botService.start();
  serviceState = "ready";
  logger.info("Morningfeed Bot is ready", { environment: envMode() });
}

async function stopServices(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  serviceState = "stopping";
  logger.info("Shutting down", { signal });

  server.close();

  try {
    await watchdogService.shutdown();
    await schedulerService.shutdown();
    await botService.stop();
    await disconnectDatabase();
  } catch (error) {
    logger.error("Graceful shutdown failed", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    process.exitCode = 1;
  }
}

const port = Number.parseInt(process.env.PORT || "5000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  logger.info("Health server is listening", { host, port });
  startServices().catch((error) => {
    logger.error("Failed to start services", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    process.exitCode = 1;
    void stopServices("startup-error");
  });
});

process.once("SIGINT", () => void stopServices("SIGINT"));
process.once("SIGTERM", () => void stopServices("SIGTERM"));
