import { io, type Socket } from 'socket.io-client';
import type { DomainEvent, EventType } from '@forgeline/shared';
import { API_BASE } from '@/api/client';

export type RealtimeEvent = DomainEvent<Record<string, unknown>>;
type Handler = (e: RealtimeEvent) => void;
type StatusListener = (connected: boolean) => void;

/**
 * Single Socket.IO connection to the `/realtime` namespace. The server places
 * the socket in the user's org/user rooms on connect; executions and
 * conversations are joined explicitly with `subscribe`.
 */
class RealtimeClient {
  private socket: Socket | null = null;
  private key = '';
  private handlers = new Set<Handler>();
  private statusListeners = new Set<StatusListener>();
  private rooms = new Map<string, number>();
  connected = false;

  connect(token: string, organizationId: string): void {
    const key = `${organizationId}:${token}`;
    if (this.socket && this.key === key) return;
    // Token rotation reuses the socket's auth on next reconnect; org change needs a new socket.
    if (this.socket && this.key.split(':')[0] === organizationId) {
      this.socket.auth = { token, organizationId };
      this.key = key;
      return;
    }
    this.disconnect();
    this.key = key;
    const socket = io(`${API_BASE}/realtime`, { auth: { token, organizationId }, transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });
    socket.on('connect', () => {
      this.setStatus(true);
      for (const room of this.rooms.keys()) socket.emit('subscribe', JSON.parse(room) as Record<string, string>);
    });
    socket.on('disconnect', () => this.setStatus(false));
    socket.on('connect_error', () => this.setStatus(false));
    socket.on('event', (e: RealtimeEvent) => this.handlers.forEach((h) => h(e)));
    this.socket = socket;
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.key = '';
    this.setStatus(false);
  }

  /** Reference-counted room subscription; returns an unsubscribe function. */
  subscribe(target: { executionId?: string; conversationId?: string }): () => void {
    const room = JSON.stringify(target);
    const count = this.rooms.get(room) ?? 0;
    this.rooms.set(room, count + 1);
    if (count === 0 && this.socket?.connected) this.socket.emit('subscribe', target);
    return () => {
      const n = (this.rooms.get(room) ?? 1) - 1;
      if (n <= 0) {
        this.rooms.delete(room);
        this.socket?.emit('unsubscribe', target);
      } else this.rooms.set(room, n);
    };
  }

  on(handler: Handler, types?: EventType[] | ((t: string) => boolean)): () => void {
    const filter = typeof types === 'function' ? types : types ? (t: string) => types.includes(t as EventType) : () => true;
    const h: Handler = (e) => filter(e.type) && handler(e);
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    l(this.connected);
    return () => this.statusListeners.delete(l);
  }

  private setStatus(c: boolean) {
    if (this.connected === c) return;
    this.connected = c;
    this.statusListeners.forEach((l) => l(c));
  }
}

export const realtime = new RealtimeClient();
