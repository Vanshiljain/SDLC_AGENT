import { Body, Controller, Get, Global, Module, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { CurrentAuth, type AuthContext } from '../common/auth/auth-context';
import { NotificationsService } from './notifications.service';

class ListQuery {
  @ApiPropertyOptional() @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean() unread?: boolean;
}
class MarkReadDto {
  @ApiPropertyOptional({ type: [String], description: 'Omit to mark all as read' }) @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('4', { each: true }) ids?: string[];
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListQuery) {
    return this.notifications.list(auth, Boolean(q.unread));
  }

  @Get('unread-count')
  unread(@CurrentAuth() auth: AuthContext) {
    return this.notifications.unreadCount(auth);
  }

  @Post('read')
  markRead(@CurrentAuth() auth: AuthContext, @Body() dto: MarkReadDto) {
    return this.notifications.markRead(auth, dto.ids ?? 'all');
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
