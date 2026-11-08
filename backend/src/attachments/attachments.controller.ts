import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Role } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { AttachmentsService } from './attachments.service';

export class UploadAttachmentDto {
  @IsString()
  @MaxLength(120)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/)
  filename: string;
  @IsIn(['application/pdf', 'image/png', 'image/jpeg', 'text/plain'])
  contentType: string;
  @IsInt() @Min(1) @Max(5 * 1024 * 1024) size: number;
  @IsString() @Matches(/^[A-Za-z0-9+/]{43}=$/) checksum: string;
}
@Controller('assets/:assetId/attachments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}
  @Get() list(@Param('assetId') assetId: string) {
    return this.attachments.list(assetId);
  }
  @Post()
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  begin(
    @Param('assetId') assetId: string,
    @Body() dto: UploadAttachmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attachments.begin(assetId, dto, user);
  }
  @Post(':id/complete')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  complete(
    @Param('assetId') assetId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attachments.complete(assetId, id, user);
  }
  @Post(':id/download')
  download(@Param('assetId') assetId: string, @Param('id') id: string) {
    return this.attachments.download(assetId, id);
  }
  @Delete(':id')
  @Roles(Role.ADMIN, Role.ASSET_MANAGER)
  remove(
    @Param('assetId') assetId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attachments.remove(assetId, id, user);
  }
}
