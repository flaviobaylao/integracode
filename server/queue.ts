import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Redis connection
// REDIS_URL must be set in Railway environment variables when Redis service
// is added to the project.  Falls back gracefully to a no-op when missing so
// the app still boots without Redis (queued jobs simply won't run).
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL;

let connection: IORedis | null = null;

export function getRedisConnection(): IORedis | null {
  if (!REDIS_URL) {
    logger.warn("REDIS_URL not set — BullMQ queues disabled");
    return null;
  }
  if (!connection) {
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
    connection.on("error", (err) => logger.error({ err }, "Redis connection error"));
    connection.on("connect", () => logger.info("Redis connected"));
  }
  return connection;
}

// ---------------------------------------------------------------------------
// Queue definitions
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = {
  OMIE_SYNC: "omie-sync",
  BILLING_SYNC: "billing-sync",
  TELEGRAM_NOTIFY: "telegram-notify",
} as const;

type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queues = new Map<string, Queue>();

export function getQueue(name: QueueName): Queue | null {
  const conn = getRedisConnection();
  if (!conn) return null;

  if (!queues.has(name)) {
    queues.set(name, new Queue(name, { connection: conn }));
  }
  return queues.get(name)!;
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

export interface OmieSyncJobData {
  instanceId: number;
  triggerType: "manual" | "scheduled";
}

export interface BillingSyncJobData {
  instanceId: number;
}

export interface TelegramNotifyJobData {
  chatId: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Worker factory — only start workers when Redis is available
// ---------------------------------------------------------------------------

export function createWorker(
  name: QueueName,
  processor: (job: Job) => Promise<void>,
): Worker | null {
  const conn = getRedisConnection();
  if (!conn) return null;

  const worker = new Worker(name, processor, { connection: conn });

  worker.on("completed", (job) =>
    logger.info({ jobId: job.id, queue: name }, "Job completed"),
  );
  worker.on("failed", (job, err) =>
    logger.error({ jobId: job?.id, queue: name, err }, "Job failed"),
  );

  logger.info({ queue: name }, "Worker started");
  return worker;
}
