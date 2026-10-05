import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { DOCUMENT_TYPES, TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PaginationQueryDto } from '../common/pagination';
import { SandboxService } from './sandbox/sandbox.service';
import { AgentTaskRunner } from './agent-task-runner.service';
import { PlanningTools } from './planning.tools';
import { TicketTools } from './tickets.tools';
import { CodeTools } from './code/code.tools';
import { QaTools } from './qa.tools';
import { DeployTools } from './deploy.tools';
import { DocsNotifyTools } from './docs-notify.tools';
import { SdlcQueriesService } from './sdlc-queries.service';

class ProjectQuery extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) environment?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}
class DocumentDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty() @IsString() @MaxLength(2_000_000) content!: string;
  @ApiPropertyOptional({ enum: DOCUMENT_TYPES }) @IsOptional() @IsIn(DOCUMENT_TYPES) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}
class TaskDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30_000) description?: string;
  @ApiPropertyOptional({ enum: TASK_STATUSES }) @IsOptional() @IsIn(TASK_STATUSES) status?: TaskStatus;
  @ApiPropertyOptional({ enum: TASK_PRIORITIES }) @IsOptional() @IsIn(TASK_PRIORITIES) priority?: TaskPriority;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
}

@ApiTags('code-generation')
@ApiBearerAuth()
@Controller('code-generation')
export class CodeGenerationController {
  constructor(private readonly q: SdlcQueriesService) {}
  @Get() @RequirePermissions('project:read') list(@CurrentAuth() a: AuthContext, @Query() q: ProjectQuery) { return this.q.codeGenerations(a, q); }
  @Get(':id') @RequirePermissions('project:read') get(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.q.codeGeneration(a, id); }
}

@ApiTags('code-review')
@ApiBearerAuth()
@Controller('code-review')
export class CodeReviewController {
  constructor(private readonly q: SdlcQueriesService) {}
  @Get() @RequirePermissions('project:read') list(@CurrentAuth() a: AuthContext, @Query() q: ProjectQuery) { return this.q.codeReviews(a, q); }
  @Get(':id') @RequirePermissions('project:read') get(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.q.codeReview(a, id); }
}

@ApiTags('qa')
@ApiBearerAuth()
@Controller('qa')
export class QaController {
  constructor(private readonly q: SdlcQueriesService) {}
  @Get('runs') @RequirePermissions('project:read') list(@CurrentAuth() a: AuthContext, @Query() q: ProjectQuery) { return this.q.qaRuns(a, q); }
  @Get('runs/:id') @RequirePermissions('project:read') get(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.q.qaRun(a, id); }
}

@ApiTags('deployments')
@ApiBearerAuth()
@Controller('deployments')
export class DeploymentsController {
  constructor(private readonly q: SdlcQueriesService) {}
  @Get() @RequirePermissions('project:read') list(@CurrentAuth() a: AuthContext, @Query() q: ProjectQuery) { return this.q.deployments(a, q); }
  @Get('environments') @RequirePermissions('project:read') board(@CurrentAuth() a: AuthContext) { return this.q.environmentsBoard(a); }
  @Get(':id') @RequirePermissions('project:read') get(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.q.deployment(a, id); }
}

@ApiTags('documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly q: SdlcQueriesService) {}
  @Get() @RequirePermissions('project:read') list(@CurrentAuth() a: AuthContext, @Query() q: ProjectQuery) { return this.q.documents(a, q); }
  @Get(':id') @RequirePermissions('project:read') get(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.q.document(a, id); }
  @Post() @RequirePermissions('docs:write') create(@CurrentAuth() a: AuthContext, @Body() dto: DocumentDto) { return this.q.saveDocument(a, null, dto); }
  @Patch(':id') @RequirePermissions('docs:write') update(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DocumentDto) { return this.q.saveDocument(a, id, dto); }
}

@ApiTags('tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(private readonly q: SdlcQueriesService) {}
  @Get() @RequirePermissions('project:read') list(@CurrentAuth() a: AuthContext, @Query() q: ProjectQuery) { return this.q.tasks(a, q); }
  @Post() @RequirePermissions('ticket:write') create(@CurrentAuth() a: AuthContext, @Body() dto: TaskDto) { return this.q.saveTask(a, null, dto); }
  @Patch(':id') @RequirePermissions('ticket:write') update(@CurrentAuth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TaskDto) { return this.q.saveTask(a, id, dto); }
}

@Global()
@Module({
  controllers: [CodeGenerationController, CodeReviewController, QaController, DeploymentsController, DocumentsController, TasksController],
  providers: [SandboxService, AgentTaskRunner, PlanningTools, TicketTools, CodeTools, QaTools, DeployTools, DocsNotifyTools, SdlcQueriesService],
  exports: [SandboxService, AgentTaskRunner, SdlcQueriesService],
})
export class SdlcModule {}
