import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AUDIT_STATUSES, type AuditStatus } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PaginationQueryDto } from '../common/pagination';
import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) resourceType?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() actorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() executionId?: string;
  @ApiPropertyOptional({ enum: AUDIT_STATUSES }) @IsOptional() @IsIn(AUDIT_STATUSES) status?: AuditStatus;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Search the audit trail' })
  @RequirePermissions('audit:read')
  list(@CurrentAuth() auth: AuthContext, @Query() q: AuditQueryDto) {
    return this.audit.list(auth.organizationId, q);
  }
}
