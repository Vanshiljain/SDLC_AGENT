import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { rooms, type DomainEvent, type EventType } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import type { AccessTokenPayload } from '../common/auth/guards';
import { EventBus } from './event-bus.service';
import { MetricsService } from '../observability/metrics.service';

interface SocketData {
  userId: string;
  organizationId: string;
}

/** High-volume events go only to the specific resource room, not the org room. */
const RESOURCE_ONLY: ReadonlySet<EventType> = new Set([
  'agent.message.delta',
  'agent.message.completed',
  'agent.tool.started',
  'agent.tool.completed',
  'workflow.log',
  'workflow.step.progress',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@WebSocketGateway({ namespace: '/realtime', cors: { origin: true, credentials: true }, transports: ['websocket', 'polling'] })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.events.onBroadcast((event) => this.relay(event));
  }

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = (socket.handshake.auth?.token as string | undefined) ?? '';
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, { secret: this.config.jwt.secret, algorithms: ['HS256'] });
      if (payload.typ !== 'access') throw new Error('bad token type');
      const requestedOrg = socket.handshake.auth?.organizationId as string | undefined;
      const membership = await this.prisma.membership.findFirst({
        where: { userId: payload.sub, ...(requestedOrg && UUID_RE.test(requestedOrg) ? { organizationId: requestedOrg } : {}), user: { isActive: true, deletedAt: null } },
        orderBy: { createdAt: 'asc' },
      });
      if (!membership) throw new Error('no membership');
      (socket.data as SocketData) = { userId: payload.sub, organizationId: membership.organizationId };
      await socket.join([rooms.org(membership.organizationId), rooms.user(payload.sub)]);
      socket.emit('ready', { organizationId: membership.organizationId });
      this.metrics.wsConnections.inc();
      socket.on('disconnect', () => this.metrics.wsConnections.dec());
    } catch {
      socket.emit('error', { message: 'Unauthorized' });
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { executionId?: string; conversationId?: string }) {
    const data = socket.data as SocketData | undefined;
    if (!data) return { ok: false };
    if (body?.executionId && UUID_RE.test(body.executionId)) {
      const exists = await this.prisma.workflowExecution.count({ where: { id: body.executionId, organizationId: data.organizationId } });
      if (!exists) return { ok: false, error: 'not_found' };
      await socket.join(rooms.execution(body.executionId));
    }
    if (body?.conversationId && UUID_RE.test(body.conversationId)) {
      const exists = await this.prisma.conversation.count({ where: { id: body.conversationId, organizationId: data.organizationId, userId: data.userId } });
      if (!exists) return { ok: false, error: 'not_found' };
      await socket.join(rooms.conversation(body.conversationId));
    }
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { executionId?: string; conversationId?: string }) {
    if (body?.executionId) await socket.leave(rooms.execution(body.executionId));
    if (body?.conversationId) await socket.leave(rooms.conversation(body.conversationId));
    return { ok: true };
  }

  private relay(event: DomainEvent): void {
    if (!this.server) return;
    const targets: string[] = [];
    if (event.userId) {
      targets.push(rooms.user(event.userId));
    } else if (RESOURCE_ONLY.has(event.type)) {
      if (event.conversationId) targets.push(rooms.conversation(event.conversationId));
      if (event.executionId) targets.push(rooms.execution(event.executionId));
    } else {
      targets.push(rooms.org(event.organizationId));
    }
    if (!targets.length) return;
    // Socket.IO namespaces: `this.server` is the namespace server.
    this.server.to(targets).emit('event', event);
  }
}
