import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/auth.guard';
import { idParam } from '../common/id-param';
import { THROTTLE } from '../work/constants';
import { FormThrottlerGuard } from '../work/controllers/form-throttler.guard';
import { FormRecordService } from '../work/services/form-record.service';
import { SignaturesService } from './signatures.service';

const sendPdf = (res: Response, { pdf, fileName }: { pdf: Buffer; fileName: string }) =>
  res
    .status(200)
    .set({ 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length), 'Content-Disposition': `inline; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
    .end(pdf);
const meta = (req: Request) => ({ ip: req.ip ?? '', userAgent: String(req.headers['user-agent'] ?? '') });

/** The signing page's side: everything is reached with the token in a signer's own link. Rate-limited. */
@Public()
@Controller('public/sign')
@UseGuards(FormThrottlerGuard)
export class SignaturePublicController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get(':token')
  @Throttle({ default: THROTTLE.read })
  view(@Param('token') token: string) {
    return this.signatures.view(token);
  }

  @Get(':token/document')
  @Throttle({ default: THROTTLE.read })
  async document(@Param('token') token: string, @Res() res: Response) {
    sendPdf(res, await this.signatures.documentFor(token));
  }

  @Post(':token')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  sign(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    return this.signatures.sign(token, body, meta(req));
  }

  @Post(':token/decline')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  decline(@Param('token') token: string, @Body() body: unknown, @Req() req: Request) {
    return this.signatures.decline(token, body, meta(req));
  }
}

/** The organisation's side: who has signed a record's documents, for people who may see that record. */
@Controller('records/:id')
export class SignaturesController {
  constructor(
    private readonly signatures: SignaturesService,
    private readonly records: FormRecordService,
  ) {}

  @Get('signatures')
  async list(@Req() req: Request & { user: { orgId: string } }, @Param('id') id: string) {
    // The same check as opening the record: not visible means not found.
    await this.records.get(req.user as never, idParam(id));
    return this.signatures.forRecord(req.user.orgId, idParam(id));
  }

  @Get('signatures/:requestId/document')
  async signed(@Req() req: Request & { user: { orgId: string } }, @Param('id') id: string, @Param('requestId') requestId: string, @Res() res: Response) {
    await this.records.get(req.user as never, idParam(id));
    sendPdf(res, await this.signatures.signedDocument(req.user.orgId, idParam(id), idParam(requestId)));
  }
}
