import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { EXECUTION_STATUSES, type ExecutionStatus } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PaginationQueryDto } from '../common/pagination';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EngineRunner } from './engine-runner.service';
import { ExecutionsService } from './executions.service';
import { RecoveryService } from './recovery.service';
import { ApprovalContextBuilder } from './approval-context.builder';

class ExecutionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EXECUTION_STATUSES }) @IsOptional() @IsIn(EXECUTION_STATUSES) status?: ExecutionStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) template?: string;
}
class LogsQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() stepId?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() after?: Date;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2000) limit?: number;
}
class CancelDto {
  @ApiPropertyOptional({ description: 'Run compensations (rollback) for completed steps' }) @IsOptional() @IsBoolean() rollback?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class ArtifactUpdateDto {
  @ApiProperty() @IsString() @MaxLength(2_000_000) content!: string;
}

@ApiTags('workflow-executions')
@ApiBearerAuth()
@Controller('workflow-executions')
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Get()
  @ApiOperation({ summary: 'List runs' })
  @RequirePermissions('workflow:read')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ExecutionQueryDto) {
    return this.executions.list(auth, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Run detail: steps, approvals, artifacts, external resources, agent runs, tool executions' })
  @RequirePermissions('workflow:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.get(auth, id);
  }

  @Get(':id/logs')
  @RequirePermissions('workflow:read')
  logs(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: LogsQueryDto) {
    return this.executions.logs(auth, id, q);
  }

  @Post(':id/pause')
  pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.pause(auth, id);
  }

  @Post(':id/resume')
  resume(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.resume(auth, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.executions.cancel(auth, id, dto);
  }

  @Post(':id/rollback')
  @ApiOperation({ summary: 'Run saga compensations for completed steps (reverse order)' })
  rollback(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.rollback(auth, id);
  }

  @Post(':id/steps/:stepId/retry')
  @ApiOperation({ summary: 'Retry a failed step (and steps skipped because of it)' })
  retry(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('stepId', ParseUUIDPipe) stepId: string) {
    return this.executions.retryStep(auth, id, stepId);
  }
}

@ApiTags('artifacts')
@ApiBearerAuth()
@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Get(':id')
  @RequirePermissions('workflow:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.executions.artifact(auth, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit an artifact (creates a new version)' })
  @RequirePermissions('workflow:execute')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArtifactUpdateDto) {
    return this.executions.updateArtifact(auth, id, dto.content);
  }
}

@Global()
@Module({
  imports: [ApprovalsModule],
  controllers: [ExecutionsController, ArtifactsController],
  providers: [EngineRunner, ExecutionsService, RecoveryService, ApprovalContextBuilder],
  exports: [EngineRunner, ExecutionsService, RecoveryService],
})
export class WorkflowExecutionModule {}
