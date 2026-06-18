import IORedis from "ioredis";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Redis cache client
// Requires REDIS_URL env var.  When not set, all cache operations are no-ops
// so the app works without Redis (just without caching).
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL;

let client: IORedis | null = null;

function getClient(): IORedis | null {
  if (!REDIS_URL) return null;
  if (!client) {
    client = new IORedis(REDIS_URL);
    client.on("error", (err) => logger.error({ err }, "Redis cache error"));
  }
  return client;
}

// Default TTL: 5 minutes
const DEFAULT_TTL_SECONDS = 300;

/**
 * Get a cached value. Returns null if key doesn't exist or Redis is unavailable.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getClient();
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch (err) {
    logger.warn({ err, key }, "Cache GET error");
    return null;
  }
}

/**
 * Set a cached value with optional TTL in seconds.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, "Cache SET error");
  }
}

/**
 * Delete a cached key.
 */
export async function cacheDel(key: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, "Cache DEL error");
  }
}

/**
 * Delete all keys matching a pattern (e.g. "omie:customers:*").
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const redis = getClient();
  if (!redis) return;
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  } catch (err) {
    logger.warn({ err, pattern }, "Cache DEL pattern error");
  }
}

/**
 * Wrap a slow async function with cache.
 * Usage: const result = await withCache("key", 300, () => fetchSlowData());
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    logger.debug({ key }, "Cache HIT");
    return cached;
  }
  const result = await fn();
  await cacheSet(key, result, ttlSeconds);
  return result;
}

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

export const CacheKeys = {
  omieCustomers: (instanceId: number) => `omie:customers:${instanceId}`,
  omieProducts: (instanceId: number) => `omie:products:${instanceId}`,
  omieOrders: (instanceId: number) => `omie:orders:${instanceId}`,
  userSession: (userId: number) => `user:session:${userId}`,
  bankAccounts: (instanceId: number) => `omie:bank-accounts:${instanceId}`,
} as const;
