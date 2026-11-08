import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ObjectStore } from './object-store';
@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, ObjectStore],
})
export class AttachmentsModule {}
