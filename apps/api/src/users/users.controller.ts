import { Body, Controller, Get, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { AllowNoOrganization, CurrentUser, type AuthContext, type AuthUserOnly } from '../common/auth/auth-context';
import { PrismaService } from '../common/prisma/prisma.service';

class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) @MaxLength(500) avatarUrl?: string;
}

const PROFILE_SELECT = { id: true, email: true, name: true, avatarUrl: true, createdAt: true, lastLoginAt: true } as const;

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  @AllowNoOrganization()
  me(@CurrentUser() user: AuthContext | AuthUserOnly) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: PROFILE_SELECT });
  }

  @Patch('me')
  @AllowNoOrganization()
  update(@CurrentUser() user: AuthContext | AuthUserOnly, @Body() dto: UpdateProfileDto) {
    return this.prisma.user.update({ where: { id: user.userId }, data: dto, select: PROFILE_SELECT });
  }
}

@Module({ controllers: [UsersController] })
export class UsersModule {}
