import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Auth, type AuthContext } from '../auth/auth-context';
import { idParam } from '../common/id-param';
import { DocumentsService } from './documents.service';

const send = (res: Response, { pdf, fileName }: { pdf: Buffer; fileName: string }) =>
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.length),
      // Shown in the browser's own viewer, saved under a name that says what it is; never guessed to be anything else.
      'Content-Disposition': `inline; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    })
    .end(pdf);

/** PDFs made by the server: of a stored response, of answers supplied by the caller, and in batches. */
@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** The PDF of one response, for anyone who may read the form's responses. */
  @Get('forms/:id/submissions/:submissionId/document')
  async ofSubmission(@Auth() auth: AuthContext, @Param('id') formId: string, @Param('submissionId') sid: string, @Res() res: Response) {
    send(res, await this.documents.download(auth, idParam(formId), idParam(sid)));
  }

  /** Generation API, one at a time: answers in, the form's PDF out. Nothing is stored. */
  @Post('forms/:id/document')
  @HttpCode(200)
  async generate(@Auth() auth: AuthContext, @Param('id') formId: string, @Body() body: unknown, @Res() res: Response) {
    send(res, await this.documents.generate(auth, idParam(formId), body));
  }

  /** Generation API, many at once: queued, made by the worker. */
  @Post('forms/:id/documents/batch')
  startBatch(@Auth() auth: AuthContext, @Param('id') formId: string, @Body() body: unknown) {
    return this.documents.startBatch(auth, idParam(formId), body);
  }

  @Get('documents/batches/:id')
  batch(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.documents.batchStatus(auth, idParam(id));
  }

  @Get('documents/batches/:id/:number')
  async batchDocument(@Auth() auth: AuthContext, @Param('id') id: string, @Param('number') number: string, @Res() res: Response) {
    send(res, await this.documents.batchDocument(auth, idParam(id), Number(number)));
  }
}
