import { Controller, Get, Global, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../common/auth/auth-context';
import { ToolRegistry } from './tool-registry.service';
import { ToolExecutor } from './tool-executor.service';

@ApiTags('tools')
@ApiBearerAuth()
@Controller('tools')
export class ToolsController {
  constructor(private readonly registry: ToolRegistry) {}

  @Get()
  @ApiOperation({ summary: 'Tool catalog with JSON input schemas (used by the Flow builder)' })
  @RequirePermissions('workflow:read')
  list() {
    return this.registry.catalog();
  }
}

@Global()
@Module({
  controllers: [ToolsController],
  providers: [ToolRegistry, ToolExecutor],
  exports: [ToolRegistry, ToolExecutor],
})
export class ToolsModule {}
