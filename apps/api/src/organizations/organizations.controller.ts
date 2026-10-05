import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ORG_ROLES, type OrgRole } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { OrganizationsService } from './organizations.service';

class OrgSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() fourEyesProduction?: boolean;
  @ApiPropertyOptional({ enum: ['JIRA', 'TRELLO'] }) @IsOptional() @IsIn(['JIRA', 'TRELLO']) defaultTicketProvider?: 'JIRA' | 'TRELLO';
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(7) @Max(3650) logRetentionDays?: number;
}
class UpdateOrgDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @ApiPropertyOptional({ type: OrgSettingsDto }) @IsOptional() @ValidateNested() @Type(() => OrgSettingsDto) settings?: OrgSettingsDto;
}
class InviteDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty({ enum: ORG_ROLES }) @IsIn(ORG_ROLES) role!: OrgRole;
}
class RoleDto {
  @ApiProperty({ enum: ORG_ROLES }) @IsIn(ORG_ROLES) role!: OrgRole;
}
class TeamDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}
class TeamMembersDto {
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(500) @IsUUID('4', { each: true }) userIds!: string[];
}

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations/current')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  @RequirePermissions('org:read')
  get(@CurrentAuth() auth: AuthContext) {
    return this.orgs.get(auth);
  }

  @Patch()
  @RequirePermissions('org:manage')
  update(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateOrgDto) {
    return this.orgs.update(auth, dto);
  }

  @Get('members')
  @RequirePermissions('org:read')
  members(@CurrentAuth() auth: AuthContext) {
    return this.orgs.listMembers(auth);
  }

  @Post('invitations')
  @RequirePermissions('members:manage')
  invite(@CurrentAuth() auth: AuthContext, @Body() dto: InviteDto) {
    return this.orgs.invite(auth, dto.email, dto.role);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequirePermissions('members:manage')
  revokeInvite(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orgs.revokeInvitation(auth, id);
  }

  @Patch('members/:id')
  @RequirePermissions('members:manage')
  updateRole(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RoleDto) {
    return this.orgs.updateMemberRole(auth, id, dto.role);
  }

  @Delete('members/:id')
  @HttpCode(204)
  @RequirePermissions('members:manage')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orgs.removeMember(auth, id);
  }

  @Get('teams')
  @RequirePermissions('org:read')
  teams(@CurrentAuth() auth: AuthContext) {
    return this.orgs.listTeams(auth);
  }

  @Post('teams')
  @RequirePermissions('members:manage')
  createTeam(@CurrentAuth() auth: AuthContext, @Body() dto: TeamDto) {
    return this.orgs.createTeam(auth, dto.name, dto.description);
  }

  @Put('teams/:id/members')
  @RequirePermissions('members:manage')
  setTeamMembers(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TeamMembersDto) {
    return this.orgs.setTeamMembers(auth, id, dto.userIds);
  }

  @Delete('teams/:id')
  @HttpCode(204)
  @RequirePermissions('members:manage')
  deleteTeam(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orgs.deleteTeam(auth, id);
  }
}
