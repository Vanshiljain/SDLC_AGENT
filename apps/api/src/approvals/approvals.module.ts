import { Body, Controller, Get, Global, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { APPROVAL_STATUSES, type ApprovalStatus } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PaginationQueryDto } from '../common/pagination';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalPolicyService } from './approval-policy.service';
import { RiskAssessor } from './risk-assessor.service';

class ApprovalQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: APPROVAL_STATUSES }) @IsOptional() @IsIn(APPROVAL_STATUSES) status?: ApprovalStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}
class DecisionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

@ApiTags('approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions('workflow:read')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ApprovalQueryDto) {
    return this.approvals.list(auth, q);
  }

  @Get(':id')
  @RequirePermissions('workflow:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.get(auth, id);
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve (requires the gate-specific permission; four-eyes for production)' })
  approve(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.approvals.decide(auth, id, true, dto.comment);
  }

  @Post(':id/reject')
  reject(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto) {
    return this.approvals.decide(auth, id, false, dto.comment);
  }
}

@Global()
@Module({
  imports: [OrganizationsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalPolicyService, RiskAssessor],
  exports: [ApprovalsService, ApprovalPolicyService, RiskAssessor],
})
export class ApprovalsModule {}
