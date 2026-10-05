import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DomainEvent, EventType } from '@forgeline/shared';
import { RedisService } from '../common/redis/redis.provider';
import type Redis from 'ioredis';

export const EVENTS_CHANNEL = 'forgeline:events';

export type PublishInput<T = Record<string, unknown>> = Omit<DomainEvent<T>, 'id' | 'occurredAt'>;

/**
 * Domain event bus.
 *  - In-process listeners (`on`) receive events published by this process
 *    exactly once — used for side effects (notifications, triggers, metrics).
 *  - Every event is also published on Redis so each API instance can relay it
 *    to its WebSocket clients (`onBroadcast`), regardless of which process
 *    (API or worker) produced it.
 * Events are notifications; state of record is always in Postgres.
 */
@Injectable()
export class EventBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventBus.name);
  private readonly local = new EventEmitter({ captureRejections: true });
  private readonly broadcast = new EventEmitter();
  private subscriber?: Redis;

  constructor(private readonly redis: RedisService) {
    this.local.setMaxListeners(100);
    this.broadcast.setMaxListeners(100);
    this.local.on('error', (err) => this.logger.error({ err }, 'Event listener failed'));
  }

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.create('events-subscriber', { maxRetriesPerRequest: null });
    await this.subscriber.subscribe(EVENTS_CHANNEL);
    this.subscriber.on('message', (_channel, message) => {
      try {
        this.broadcast.emit('event', JSON.parse(message) as DomainEvent);
      } catch (err) {
        this.logger.warn({ err }, 'Dropped malformed event');
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.unsubscribe(EVENTS_CHANNEL).catch(() => undefined);
  }

  async publish<T extends Record<string, unknown>>(input: PublishInput<T>): Promise<DomainEvent<T>> {
    const event: DomainEvent<T> = { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
    // Local side-effect listeners: never let them break the publisher.
    for (const listener of this.local.listeners(event.type)) {
      Promise.resolve()
        .then(() => (listener as (e: DomainEvent<T>) => unknown)(event))
        .catch((err: unknown) => this.logger.error({ err, type: event.type }, 'Event handler failed'));
    }
    try {
      await this.redis.client.publish(EVENTS_CHANNEL, JSON.stringify(event));
    } catch (err) {
      this.logger.warn({ err, type: event.type }, 'Realtime fan-out failed (clients will resync on next fetch)');
    }
    return event;
  }

  on<T = Record<string, unknown>>(type: EventType, handler: (event: DomainEvent<T>) => unknown): void {
    this.local.on(type, handler as (e: DomainEvent) => unknown);
  }

  onBroadcast(handler: (event: DomainEvent) => void): void {
    this.broadcast.on('event', handler);
  }
}
