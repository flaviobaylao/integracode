import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Structured logger using Pino.
 * In development: pretty-prints to stdout with colors.
 * In production: outputs JSON lines for log aggregators (Railway, etc.).
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {
        // Production: structured JSON
        formatters: {
          level(label) {
            return { level: label };
          },
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }),
});

/** Express-compatible request logger middleware */
export function requestLogger(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  const start = Date.now();

  res.on("finish", () => {
    if (req.path.startsWith("/api")) {
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
        },
        `${req.method} ${req.path} ${res.statusCode}`,
      );
    }
  });

  next();
}
