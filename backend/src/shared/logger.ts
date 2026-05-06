import { Logger } from "@aws-lambda-powertools/logger";

export const logger = new Logger({
  serviceName: process.env.SERVICE_NAME ?? "ai-homework-helper",
  logLevel:
    (process.env.LOG_LEVEL as "DEBUG" | "INFO" | "WARN" | "ERROR" | "SILENT") ??
    "DEBUG",
});
