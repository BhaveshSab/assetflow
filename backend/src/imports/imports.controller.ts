import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { ImportsService } from './imports.service';
class CsvDto {
  @IsString() @MaxLength(60000) csv: string;
}
@Controller('asset-imports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.ASSET_MANAGER)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}
  @Post('preview') preview(@Body() dto: CsvDto, @CurrentUser() user: AuthUser) {
    return this.imports.preview(dto.csv, user);
  }
  @Get() list(@CurrentUser() user: AuthUser) {
    return this.imports.list(user);
  }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.imports.get(id, user);
  }
  @Post(':id/confirm') confirm(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.imports.transition(id, user, 'confirm');
  }
  @Post(':id/cancel') cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.imports.transition(id, user, 'cancel');
  }
  @Post(':id/retry') retry(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.imports.transition(id, user, 'retry');
  }
}
