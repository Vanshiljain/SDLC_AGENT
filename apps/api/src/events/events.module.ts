import { Global, Module } from '@nestjs/common';
import { EventBus } from './event-bus.service';
import { RealtimeGateway } from './realtime.gateway';

@Global()
@Module({
  providers: [EventBus, RealtimeGateway],
  exports: [EventBus],
})
export class EventsModule {}
