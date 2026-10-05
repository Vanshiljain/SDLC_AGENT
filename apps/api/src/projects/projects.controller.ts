import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { ProjectsService } from './projects.service';
import {
  CreateProjectDto,
  EnvironmentDto,
  LinkRepositoryDto,
  ProjectMemberDto,
  UpdateEnvironmentDto,
  UpdateProjectDto,
  UpdateRepositoryDto,
} from './projects.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'Projects with health, deployments and run statistics' })
  @RequirePermissions('project:read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.projects.list(auth);
  }

  @Post()
  @RequirePermissions('project:create')
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateProjectDto) {
    return this.projects.create(auth, dto);
  }

  @Get(':projectId')
  @RequirePermissions('project:read', { projectFrom: 'param:projectId' })
  get(@CurrentAuth() auth: AuthContext, @Param('projectId', ParseUUIDPipe) id: string) {
    return this.projects.get(auth, id);
  }

  @Patch(':projectId')
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  update(@CurrentAuth() auth: AuthContext, @Param('projectId', ParseUUIDPipe) id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(auth, id, dto);
  }

  @Delete(':projectId')
  @HttpCode(204)
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  remove(@CurrentAuth() auth: AuthContext, @Param('projectId', ParseUUIDPipe) id: string) {
    return this.projects.remove(auth, id);
  }

  @Put(':projectId/members')
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  setMember(@CurrentAuth() auth: AuthContext, @Param('projectId', ParseUUIDPipe) id: string, @Body() dto: ProjectMemberDto) {
    return this.projects.upsertMember(auth, id, dto.userId, dto.role);
  }

  @Delete(':projectId/members/:userId')
  @HttpCode(204)
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.projects.removeMember(auth, id, userId);
  }

  @Post(':projectId/repositories')
  @ApiOperation({ summary: 'Link a GitHub repository (verified via the GitHub connection)' })
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  linkRepository(@CurrentAuth() auth: AuthContext, @Param('projectId', ParseUUIDPipe) id: string, @Body() dto: LinkRepositoryDto) {
    return this.projects.linkRepository(auth, id, dto);
  }

  @Patch(':projectId/repositories/:repositoryId')
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  updateRepository(
    @CurrentAuth() auth: AuthContext,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Param('repositoryId', ParseUUIDPipe) repoId: string,
    @Body() dto: UpdateRepositoryDto,
  ) {
    return this.projects.updateRepository(auth, id, repoId, dto);
  }

  @Delete(':projectId/repositories/:repositoryId')
  @HttpCode(204)
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  unlinkRepository(
    @CurrentAuth() auth: AuthContext,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Param('repositoryId', ParseUUIDPipe) repoId: string,
  ) {
    return this.projects.unlinkRepository(auth, id, repoId);
  }

  @Post(':projectId/environments')
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  createEnvironment(@CurrentAuth() auth: AuthContext, @Param('projectId', ParseUUIDPipe) id: string, @Body() dto: EnvironmentDto) {
    return this.projects.createEnvironment(auth, id, dto);
  }

  @Patch(':projectId/environments/:environmentId')
  @RequirePermissions('project:manage', { projectFrom: 'param:projectId' })
  updateEnvironment(
    @CurrentAuth() auth: AuthContext,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Param('environmentId', ParseUUIDPipe) envId: string,
    @Body() dto: UpdateEnvironmentDto,
  ) {
    return this.projects.updateEnvironment(auth, id, envId, dto);
  }
}

@ApiTags('repositories')
@ApiBearerAuth()
@Controller('repositories')
export class RepositoriesController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermissions('project:read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.projects.listRepositories(auth);
  }
}
