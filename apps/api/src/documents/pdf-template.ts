import { BadRequestException, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { Request } from 'express';
import type { HydratedDocument, Model } from 'mongoose';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { newId } from '../common/crypto';
import { idParam } from '../common/id-param';
import { OBJECT_STORE, type ObjectStore } from '../common/object-store';
import { fillableBoxes, OWN_PDF_MAX_BYTES } from './own-pdf';

/**
 * A fillable PDF of the organisation's own (their claim form, their application form) kept so that responses can
 * be written into it. The file itself is in file storage; here is what it is called and which boxes it has.
 */
@Schema({ collection: 'pdf_templates', timestamps: true })
export class PdfTemplate {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) size: number;
  @Prop({ type: [{ name: String, kind: String, _id: false }], default: [] }) boxes: { name: string; kind: 'text' | 'tick' | 'choice' }[];
  @Prop({ required: true }) createdBy: string;
  createdAt?: Date;
}
export type PdfTemplateDocument = HydratedDocument<PdfTemplate>;
export const PdfTemplateSchema = SchemaFactory.createForClass(PdfTemplate);

const view = (t: PdfTemplate) => ({ id: t.id, name: t.name, size: t.size, boxes: t.boxes, addedAt: t.createdAt });

@Injectable()
export class PdfTemplatesService {
  constructor(
    @InjectModel(PdfTemplate.name) private readonly templates: Model<PdfTemplateDocument>,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async list(orgId: string) {
    return (await this.templates.find({ orgId }).sort({ name: 1 }).limit(200).lean()).map(view);
  }

  /** Keeps an uploaded PDF, once it is seen to be a PDF with boxes that answers can go into. */
  async add(auth: AuthContext, nameInput: unknown, file: unknown) {
    if (!Buffer.isBuffer(file) || !file.length) throw new BadRequestException('Choose a PDF file');
    if (file.length > OWN_PDF_MAX_BYTES) throw new BadRequestException(`The PDF must be at most ${OWN_PDF_MAX_BYTES / 1048576} MB`);
    if (file.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BadRequestException('That file is not a PDF');
    const boxes = await fillableBoxes(file).catch(() => {
      throw new BadRequestException('That PDF could not be read. Save it again from the program that made it and try once more.');
    });
    if (!boxes.length) throw new BadRequestException('That PDF has no boxes to fill in. It needs to be a fillable PDF (made with form fields).');
    const name = (typeof nameInput === 'string' ? nameInput : '').replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N} ._()-]/gu, ' ').trim().slice(0, 80) || 'Our PDF';
    const id = newId();
    const key = `pdf-templates/${auth.orgId}/${id}.pdf`;
    await this.store.put(key, file, 'application/pdf');
    const row = await this.templates.create({ id, orgId: auth.orgId, name, key, size: file.length, boxes, createdBy: auth.userId });
    return view(row);
  }

  async remove(orgId: string, id: string) {
    const row = await this.templates.findOneAndDelete({ orgId, id }).lean();
    if (!row) throw new NotFoundException('That PDF is not in your library');
    await this.store.remove(row.key).catch(() => undefined);
  }

  /** The bytes of one of this organisation's PDFs, or null when it has gone. */
  async bytes(orgId: string, id: string): Promise<Buffer | null> {
    const row = await this.templates.findOne({ orgId, id }).lean();
    return row ? this.store.get(row.key) : null;
  }
}

/** The organisation's own fillable PDFs. The upload is the file itself as the request body (not JSON), up to 4 MB. */
@Controller('pdf-templates')
export class PdfTemplatesController {
  constructor(private readonly templates: PdfTemplatesService) {}

  @Get()
  @RequirePermission('form.view')
  list(@Auth() auth: AuthContext) {
    return this.templates.list(auth.orgId);
  }

  @Post()
  @RequirePermission('form.edit')
  add(@Auth() auth: AuthContext, @Query('name') name: string, @Req() req: Request) {
    return this.templates.add(auth, name, req.body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('form.edit')
  async remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    await this.templates.remove(auth.orgId, idParam(id));
  }
}
