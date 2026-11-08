import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { LookupAssetDto } from './dto/lookup-asset.dto';
import { AssetsService } from './assets.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

/** Feature 4 — Asset Registration & Directory. */
@Controller('assets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** Register a new asset (auto-generates its assetTag). */
  @Post()
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  create(@Body() dto: CreateAssetDto, @CurrentUser() user: AuthUser) {
    return this.assets.create(dto, user);
  }

  /** Search / filter the asset directory. Any authenticated user. */
  @Get()
  findAll(@Query() query: QueryAssetsDto) {
    return this.assets.findAll(query);
  }

  /** QR contains a public identifier, never an authentication token. */
  @Get('lookup/by-tag')
  lookup(@Query() query: LookupAssetDto) {
    return this.assets.lookup(query.tag);
  }

  /** Full detail for one asset. Any authenticated user. */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.assets.findOne(id);
  }

  /** Combined allocation + maintenance history, newest-first. */
  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.assets.history(id);
  }

  /** Edit descriptive fields / retire-dispose-lose the asset. */
  @Patch(':id')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assets.update(id, dto, user);
  }
}
