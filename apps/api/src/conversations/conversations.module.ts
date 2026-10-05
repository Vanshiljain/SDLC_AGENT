import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { PageContext } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { ConversationsService } from './conversations.service';

class CreateConversationDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) title?: string;
}
class UpdateConversationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(120) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() archived?: boolean;
}
class SendMessageDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(20_000) content!: string;
  @ApiPropertyOptional({ description: 'What the user is looking at (global assistant)' }) @IsOptional() @IsObject() pageContext?: PageContext;
}
class StartProposalDto {
  @ApiPropertyOptional() @IsOptional() @IsObject() inputs?: Record<string, unknown>;
}

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequirePermissions('agent:use')
  list(@CurrentAuth() auth: AuthContext) {
    return this.conversations.list(auth);
  }

  @Post()
  @RequirePermissions('agent:use')
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateConversationDto) {
    return this.conversations.create(auth, dto.projectId, dto.title);
  }

  @Get(':id')
  @RequirePermissions('agent:use')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.get(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('agent:use')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConversationDto) {
    return this.conversations.update(auth, id, dto);
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a message; the agent response streams over the realtime socket' })
  @RequirePermissions('agent:use')
  send(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.conversations.send(auth, id, dto.content, dto.pageContext);
  }

  @Post(':id/cancel')
  @RequirePermissions('agent:use')
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.cancel(auth, id);
  }

  @Get(':id/proposals/:proposalId')
  @RequirePermissions('agent:use')
  proposal(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('proposalId', ParseUUIDPipe) proposalId: string) {
    return this.conversations.proposal(auth, id, proposalId);
  }

  @Post(':id/proposals/:proposalId/start')
  @ApiOperation({ summary: 'Start a proposed flow (server-stored definitions only)' })
  @RequirePermissions('workflow:execute')
  start(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('proposalId', ParseUUIDPipe) proposalId: string, @Body() dto: StartProposalDto) {
    return this.conversations.startProposal(auth, id, proposalId, dto.inputs);
  }

  @Post(':id/proposals/:proposalId/dismiss')
  @RequirePermissions('agent:use')
  dismiss(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('proposalId', ParseUUIDPipe) proposalId: string) {
    return this.conversations.dismissProposal(auth, id, proposalId);
  }
}

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
