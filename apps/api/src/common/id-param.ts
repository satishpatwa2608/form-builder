import { BadRequestException } from '@nestjs/common';

/** Ids in URLs: uuid-like tokens only. */
export function idParam(value: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new BadRequestException('Invalid id');
  return value;
}
