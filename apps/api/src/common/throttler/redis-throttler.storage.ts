import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed rate-limit storage so limits hold across API replicas.
 * Atomic via a Lua script: fixed window counter + optional block period.
 */
const SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitsKey) or '0')
  return {hits, redis.call('PTTL', hitsKey), 1, blockTtl}
end
local hits = redis.call('INCR', hitsKey)
if hits == 1 then redis.call('PEXPIRE', hitsKey, ttl) end
local ttlLeft = redis.call('PTTL', hitsKey)
if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  return {hits, ttlLeft, 1, blockDuration}
end
return {hits, ttlLeft, 0, 0}
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `forgeline:rl:${throttlerName}:${key}`;
    const res = (await this.redis.eval(SCRIPT, 2, `${base}:hits`, `${base}:block`, ttl, limit, blockDuration || ttl)) as [
      number,
      number,
      number,
      number,
    ];
    return {
      totalHits: Number(res[0]),
      timeToExpire: Math.max(0, Math.ceil(Number(res[1]) / 1000)),
      isBlocked: Number(res[2]) === 1,
      timeToBlockExpire: Math.max(0, Math.ceil(Number(res[3]) / 1000)),
    };
  }
}
