import { Body, Controller, Delete, Get, Global, HttpCode, Injectable, Module, type OnModuleInit, Param, ParseUUIDPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUrl, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { z } from 'zod';
import { defineLooseTool } from '@forgeline/integrations';
import { KNOWLEDGE_SOURCE_TYPES, type KnowledgeSourceType } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PaginationQueryDto } from '../common/pagination';
import { AppException } from '../common/errors';
import { ToolRegistry } from '../tools/tool-registry.service';
import { KnowledgeService } from './knowledge.service';

const csv = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value);

class ListDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ enum: KNOWLEDGE_SOURCE_TYPES }) @IsOptional() @IsIn(KNOWLEDGE_SOURCE_TYPES) sourceType?: KnowledgeSourceType;
  @ApiPropertyOptional() @IsOptional() @IsIn(['PENDING', 'PROCESSING', 'INDEXED', 'FAILED']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
}
class SearchDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(1000) query!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @Transform(csv) @IsArray() documentTypes?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @Transform(csv) @IsArray() sourceTypes?: string[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(30) k?: number;
}
class TextDocDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(300) title!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(400_000) content!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional({ enum: KNOWLEDGE_SOURCE_TYPES }) @IsOptional() @IsIn(KNOWLEDGE_SOURCE_TYPES) sourceType?: KnowledgeSourceType;
  @ApiPropertyOptional({ description: 'architecture | api | guideline | spec | runbook | markdown …' }) @IsOptional() @IsString() @MaxLength(40) documentType?: string;
}
class UrlDocDto {
  @ApiProperty() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) url!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) documentType?: string;
  @ApiPropertyOptional({ enum: KNOWLEDGE_SOURCE_TYPES }) @IsOptional() @IsIn(KNOWLEDGE_SOURCE_TYPES) sourceType?: KnowledgeSourceType;
}
class RepoIngestDto {
  @ApiProperty() @IsUUID() projectId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) ref?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) pathPrefix?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(1000) maxFiles?: number;
}
class JiraIngestDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) jql!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}
class NotionIngestDto {
  @ApiProperty() @IsString() @MaxLength(200) query!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
}
class UploadMetaDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) documentType?: string;
  @ApiPropertyOptional({ enum: KNOWLEDGE_SOURCE_TYPES }) @IsOptional() @IsIn(KNOWLEDGE_SOURCE_TYPES) sourceType?: KnowledgeSourceType;
}

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('documents')
  @RequirePermissions('knowledge:read')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListDto) {
    return this.knowledge.list(auth, q);
  }

  @Get('stats')
  @RequirePermissions('knowledge:read')
  stats(@CurrentAuth() auth: AuthContext) {
    return this.knowledge.stats(auth);
  }

  @Get('documents/:id')
  @RequirePermissions('knowledge:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.get(auth, id);
  }

  @Post('search')
  @HttpCode(200)
  @ApiOperation({ summary: 'Semantic search (tenant- and project-scoped)' })
  @RequirePermissions('knowledge:read')
  search(@CurrentAuth() auth: AuthContext, @Body() dto: SearchDto) {
    return this.knowledge.search(auth, dto);
  }

  @Post('documents')
  @RequirePermissions('knowledge:manage')
  createText(@CurrentAuth() auth: AuthContext, @Body() dto: TextDocDto) {
    return this.knowledge.ingestText({
      organizationId: auth.organizationId,
      projectId: dto.projectId,
      userId: auth.userId,
      sourceType: dto.sourceType ?? 'UPLOAD',
      sourceRef: `text:${dto.projectId ?? 'org'}:${dto.title}`,
      title: dto.title,
      content: dto.content,
      documentType: dto.documentType ?? 'markdown',
    });
  }

  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @RequirePermissions('knowledge:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: Express.Multer.File | undefined, @Body() meta: UploadMetaDto) {
    if (!file) throw AppException.badRequest('A file is required', 'FILE_REQUIRED');
    return this.knowledge.ingestUpload(auth, file, meta);
  }

  @Post('url')
  @RequirePermissions('knowledge:manage')
  url(@CurrentAuth() auth: AuthContext, @Body() dto: UrlDocDto) {
    return this.knowledge.ingestUrl(auth, dto.url, dto);
  }

  @Post('sources/github')
  @ApiOperation({ summary: "Index the project's GitHub repository" })
  @RequirePermissions('knowledge:manage', { projectFrom: 'body:projectId' })
  github(@CurrentAuth() auth: AuthContext, @Body() dto: RepoIngestDto) {
    return this.knowledge.ingestGitHubRepository(auth, dto.projectId, dto);
  }

  @Post('sources/jira')
  @RequirePermissions('knowledge:manage')
  jira(@CurrentAuth() auth: AuthContext, @Body() dto: JiraIngestDto) {
    return this.knowledge.ingestJira(auth, dto.projectId, dto.jql);
  }

  @Post('sources/notion')
  @RequirePermissions('knowledge:manage')
  notion(@CurrentAuth() auth: AuthContext, @Body() dto: NotionIngestDto) {
    return this.knowledge.ingestNotion(auth, dto.projectId, dto.query);
  }

  @Post('documents/:id/reindex')
  @RequirePermissions('knowledge:manage')
  reindex(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.reindex(auth, id);
  }

  @Delete('documents/:id')
  @HttpCode(204)
  @RequirePermissions('knowledge:manage')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledge.remove(auth, id);
  }
}

/** Registers knowledge tools for agents and Flows. */
@Injectable()
export class KnowledgeTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly knowledge: KnowledgeService,
  ) {}

  onModuleInit(): void {
    const knowledge = this.knowledge;
    this.registry.register(
      defineLooseTool({
        name: 'knowledge.retrieve',
        title: 'Retrieve project context',
        description: 'Semantic search over indexed project knowledge (docs, code, tickets, specs, past runs) to ground AI decisions.',
        category: 'ai',
        provider: null,
        agent: 'architect',
        inputSchema: z.object({ query: z.string().min(2).max(2000), k: z.number().int().min(1).max(20).default(8), documentTypes: z.array(z.string()).optional() }),
        permission: 'knowledge:read',
        risk: 'read',
        sideEffects: false,
        async execute(input, ctx) {
          const res = await knowledge.retrieve({ organizationId: ctx.organizationId, projectId: ctx.project?.id, query: input.query, k: input.k, documentTypes: input.documentTypes });
          ctx.logger.info(res.sources.length ? `Retrieved ${res.sources.length} source(s)` : res.context);
          return {
            output: { context: res.context, sources: res.sources, available: res.available },
            summary: res.sources.length ? `Retrieved ${res.sources.length} relevant source(s): ${res.sources.slice(0, 3).map((s) => s.title).join(', ')}` : res.context,
          };
        },
        async simulate(input) {
          return {
            simulated: true,
            output: {
              context: `[1] Authentication Service — Architecture (demo)\nThe auth service is a NestJS module using JWT access tokens, refresh tokens stored hashed in PostgreSQL, and Prisma for persistence. Email is sent via the notifications module.\n\n[2] Security guidelines (demo)\nTokens must be single-use, hashed at rest, and expire within 30 minutes.`,
              sources: [
                { documentId: 'demo-1', title: 'Authentication Service — Architecture', sourceType: 'ARCHITECTURE', url: null, score: 0.89, location: null },
                { documentId: 'demo-2', title: 'Security guidelines', sourceType: 'GUIDELINE', url: null, score: 0.81, location: null },
              ],
              available: true,
            },
            summary: `[Simulated] Retrieved 2 sources for "${input.query.slice(0, 60)}"`,
          };
        },
      }),
    );
  }
}

@Global()
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeTools],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
