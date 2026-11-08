import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}
  @Get()
  overview() {
    return this.jobs.overview();
  }
  @Post(':id/retry')
  @HttpCode(200)
  retry(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.jobs.retry(id, user.id);
  }
}
