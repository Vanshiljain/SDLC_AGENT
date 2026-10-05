import { Body, Controller, Delete, Get, Global, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { WorkflowDefinitionInput } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { WorkflowsService } from './workflows.service';
import { TriggersService } from './triggers.service';

class SaveWorkflowDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) category?: string;
  @ApiProperty({ description: 'Flow definition (see shared workflowDefinitionSchema)' }) @IsObject() definition!: WorkflowDefinitionInput;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isTemplate?: boolean;
}
class UpdateWorkflowDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) category?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() definition?: WorkflowDefinitionInput;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isTemplate?: boolean;
}
class ValidateDto {
  @ApiProperty() @IsObject() definition!: Record<string, unknown>;
}
class FromTemplateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}
class RunDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() input?: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) idempotencyKey?: string;
}
class StatusDto {
  @ApiProperty({ enum: ['ACTIVE', 'DRAFT', 'ARCHIVED'] }) @IsIn(['ACTIVE', 'DRAFT', 'ARCHIVED']) status!: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
}
class TriggerDto {
  @ApiProperty({ description: '{ type: MANUAL } | { type: SCHEDULE, cron, timezone } | { type: EVENT, event, filter?, inputs? }' })
  @IsObject()
  config!: Record<string, unknown>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}
class GenerateDto {
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(4000) description!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}
class ListQuery {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('templates')
  @ApiOperation({ summary: 'Built-in Flow templates' })
  @RequirePermissions('workflow:read')
  templates() {
    return this.workflows.templates();
  }

  @Post('templates/:key/clone')
  @RequirePermissions('workflow:manage')
  fromTemplate(@CurrentAuth() auth: AuthContext, @Param('key') key: string, @Body() dto: FromTemplateDto) {
    return this.workflows.fromTemplate(auth, key, dto);
  }

  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validate a Flow definition (DAG, tools, templates, expressions)' })
  @RequirePermissions('workflow:read')
  validate(@Body() dto: ValidateDto) {
    const r = this.workflows.validate(dto.definition);
    return { valid: r.valid, issues: r.issues, definition: r.valid ? this.workflows.withLayout(r.definition) : (r.definition ?? null) };
  }

  @Post('generate')
  @ApiOperation({ summary: 'Describe a workflow in natural language; returns a validated draft for review' })
  @RequirePermissions(['workflow:manage', 'agent:use'])
  generate(@CurrentAuth() auth: AuthContext, @Body() dto: GenerateDto) {
    return this.workflows.generate(auth, dto.description, dto.projectId);
  }

  @Get()
  @RequirePermissions('workflow:read')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListQuery) {
    return this.workflows.list(auth, q.projectId);
  }

  @Post()
  @RequirePermissions('workflow:manage')
  create(@CurrentAuth() auth: AuthContext, @Body() dto: SaveWorkflowDto) {
    return this.workflows.create(auth, dto);
  }

  @Get(':id')
  @RequirePermissions('workflow:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.get(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('workflow:manage')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateWorkflowDto) {
    return this.workflows.update(auth, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions('workflow:manage')
  status(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    return this.workflows.setStatus(auth, id, dto.status);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('workflow:manage')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflows.remove(auth, id);
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Start a run of this Flow' })
  @RequirePermissions('workflow:execute')
  run(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RunDto) {
    return this.workflows.run(auth, id, dto);
  }

  @Post(':id/triggers')
  @RequirePermissions('workflow:manage')
  addTrigger(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TriggerDto) {
    return this.workflows.setTrigger(auth, id, dto.config, dto.enabled ?? true);
  }

  @Delete(':id/triggers/:triggerId')
  @HttpCode(204)
  @RequirePermissions('workflow:manage')
  removeTrigger(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('triggerId', ParseUUIDPipe) triggerId: string,
  ) {
    return this.workflows.removeTrigger(auth, id, triggerId);
  }
}

@Global()
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, TriggersService],
  exports: [WorkflowsService, TriggersService],
})
export class WorkflowsModule {}
