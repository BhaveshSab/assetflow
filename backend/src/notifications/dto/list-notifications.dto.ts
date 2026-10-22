import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** Query filters for GET /notifications. */
export class ListNotificationsDto {
  /** When true, only unread notifications are returned. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unread?: boolean;
}
