import { BadRequestException, Controller, ForbiddenException, Get, Inject, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../auth/auth.guard';
import { OBJECT_STORE, type LocalObjectStore } from '../../common/object-store';

/** Development stand-in for S3 pre-signed links (only registered when STORAGE_PROVIDER=local). */
@Public()
@Controller('public/local-store')
export class LocalStoreController {
  constructor(@Inject(OBJECT_STORE) private readonly store: LocalObjectStore) {}

  @Put(':token')
  async put(@Param('token') token: string, @Req() req: Request) {
    const grant = this.store.verify(token, 'put');
    if (!grant) throw new ForbiddenException('This upload link is not valid');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length !== grant.size) throw new BadRequestException('The file does not match what was declared');
    if ((req.headers['content-type'] ?? '') !== grant.contentType) throw new BadRequestException('Wrong content type');
    await this.store.write(grant.key, body);
    return { ok: true };
  }

  @Get(':token')
  async get(@Param('token') token: string, @Res() res: Response) {
    const grant = this.store.verify(token, 'get');
    if (!grant) throw new ForbiddenException('This download link is not valid');
    res.setHeader('Content-Disposition', `attachment; filename="${grant.name ?? 'file'}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(await this.store.read(grant.key));
  }
}
