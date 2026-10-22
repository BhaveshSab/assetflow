import { IsString, MinLength } from 'class-validator';

/** Body for POST /notifications/ping — remind the holder of an allocation. */
export class PingAllocationDto {
  @IsString()
  @MinLength(1)
  allocationId: string;
}
