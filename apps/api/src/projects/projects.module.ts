import { Global, Module } from '@nestjs/common';
import { ProjectsController, RepositoriesController } from './projects.controller';
import { ProjectContextService, ProjectsService } from './projects.service';

@Global()
@Module({
  controllers: [ProjectsController, RepositoriesController],
  providers: [ProjectsService, ProjectContextService],
  exports: [ProjectsService, ProjectContextService],
})
export class ProjectsModule {}
