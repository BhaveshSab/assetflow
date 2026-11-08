import { IsString, Matches } from 'class-validator';
export class LookupAssetDto {
  @IsString() @Matches(/^AF-[0-9]{4,12}$/) tag: string;
}
