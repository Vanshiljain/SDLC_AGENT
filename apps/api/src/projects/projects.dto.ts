import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ENVIRONMENT_TYPES, PROJECT_ROLES, type EnvironmentType, type ProjectRole } from '@forgeline/shared';

export class ProjectSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,19}$/) jiraProjectKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) jiraIssueType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) trelloBoardId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) trelloListId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) trelloDoneListId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) notionParentPageId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) slackChannel?: string;
  @ApiPropertyOptional({ enum: ['JIRA', 'TRELLO'] }) @IsOptional() @IsIn(['JIRA', 'TRELLO']) ticketProvider?: 'JIRA' | 'TRELLO';
  @ApiPropertyOptional({ enum: ['CUSTOM_DEVOPS', 'GITHUB_ACTIONS'] })
  @IsOptional()
  @IsIn(['CUSTOM_DEVOPS', 'GITHUB_ACTIONS'])
  cicdProvider?: 'CUSTOM_DEVOPS' | 'GITHUB_ACTIONS';
  @ApiPropertyOptional({ description: 'Map of policy action → auto|required, e.g. {"pr.create":"required"}' })
  @IsOptional()
  @IsObject()
  approvalPolicy?: Record<string, 'auto' | 'required'>;
}

export class CreateProjectDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiProperty({ description: 'Short uppercase key, e.g. AUTH' }) @IsString() @Matches(/^[A-Z][A-Z0-9]{1,9}$/) key!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() teamId?: string;
  @ApiPropertyOptional({ type: ProjectSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProjectSettingsDto)
  settings?: ProjectSettingsDto;
  @ApiPropertyOptional({ description: 'Create default development/staging/production environments' })
  @IsOptional()
  @IsBoolean()
  createDefaultEnvironments?: boolean;
}

export class UpdateProjectDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() teamId?: string | null;
  @ApiPropertyOptional({ type: ProjectSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProjectSettingsDto)
  settings?: ProjectSettingsDto;
}

export class ProjectMemberDto {
  @ApiProperty() @IsUUID() userId!: string;
  @ApiProperty({ enum: PROJECT_ROLES }) @IsIn(PROJECT_ROLES) role!: ProjectRole;
}

export class RepositorySettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) installCommand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) lintCommand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) typecheckCommand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) testCommand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) buildCommand?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[\w./:@-]+$/) @MaxLength(200) sandboxImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) ciWorkflow?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) deployWorkflow?: string;
}

export class LinkRepositoryDto {
  @ApiProperty({ description: 'owner/name' }) @IsString() @Matches(/^[\w.-]+\/[\w.-]+$/) fullName!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() integrationId?: string;
  @ApiPropertyOptional({ type: RepositorySettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RepositorySettingsDto)
  settings?: RepositorySettingsDto;
}

export class UpdateRepositoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) defaultBranch?: string;
  @ApiPropertyOptional({ type: RepositorySettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RepositorySettingsDto)
  settings?: RepositorySettingsDto;
}

export class SmokeTestDto {
  @ApiProperty() @IsString() @MaxLength(100) name!: string;
  @ApiPropertyOptional({ enum: ['GET', 'POST', 'HEAD'] }) @IsOptional() @IsIn(['GET', 'POST', 'HEAD']) method?: 'GET' | 'POST' | 'HEAD';
  @ApiProperty() @IsString() @Matches(/^\//) @MaxLength(500) path!: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(100) @Max(599) expectStatus?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) expectBodyContains?: string;
}

export class EnvironmentDto {
  @ApiProperty() @IsString() @Matches(/^[a-z][a-z0-9-]{1,30}$/) name!: string;
  @ApiProperty({ enum: ENVIRONMENT_TYPES }) @IsIn(ENVIRONMENT_TYPES) type!: EnvironmentType;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true }) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\//) healthCheckPath?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @ApiPropertyOptional({ type: [SmokeTestDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SmokeTestDto)
  smokeTests?: SmokeTestDto[];
  @ApiPropertyOptional() @IsOptional() @IsObject() config?: Record<string, unknown>;
}

export class UpdateEnvironmentDto {
  @ApiPropertyOptional() @IsOptional() @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true }) url?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^\//) healthCheckPath?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @ApiPropertyOptional({ type: [SmokeTestDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SmokeTestDto)
  smokeTests?: SmokeTestDto[];
  @ApiPropertyOptional() @IsOptional() @IsObject() config?: Record<string, unknown>;
}
