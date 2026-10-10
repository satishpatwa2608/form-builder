import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument, Model } from 'mongoose';
import { z } from 'zod';
import { actorOf, AuditService } from '../audit/audit.service';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { newId } from '../common/crypto';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';

/**
 * An email written once for the organisation and used wherever one is sent: by the team writing to a requester
 * from a record, and as the starting text of a workflow's email step on any form. Using one copies its words,
 * so an email already set up on a form does not change under it.
 */
@Schema({ timestamps: true, collection: 'email_templates' })
export class EmailTemplateRow {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) subject: string;
  @Prop({ required: true }) body: string;
  @Prop({ required: true }) updatedBy: string;
  updatedAt: Date;
}
export type EmailTemplateDocument = HydratedDocument<EmailTemplateRow>;
export const EmailTemplateSchema = SchemaFactory.createForClass(EmailTemplateRow);

const MAX = 200;
const body = z.object({ name: z.string().trim().min(1, 'Give the email a name').max(80), subject: z.string().trim().min(1, 'The email needs a subject').max(200), body: z.string().trim().min(1, 'The email needs a message').max(10_000) });
type Input = z.infer<typeof body>;

@Injectable()
export class EmailTemplatesService {
  constructor(
    private readonly audit: AuditService,
    @InjectModel(EmailTemplateRow.name) private readonly rows: Model<EmailTemplateDocument>,
  ) {}

  private static view(r: EmailTemplateRow) {
    return { id: r.id, name: r.name, subject: r.subject, body: r.body, updatedAt: r.updatedAt };
  }

  async list(orgId: string) {
    return (await this.rows.find({ orgId }).sort({ name: 1 }).lean()).map(EmailTemplatesService.view);
  }

  private async unique(orgId: string, name: string, except?: string) {
    const clash = await this.rows.findOne({ orgId, name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
    if (clash && clash.id !== except) throw new BadRequestException({ message: 'There is already an email of this name', errors: [{ field: 'name', message: 'There is already an email of this name' }] });
  }

  async create(auth: AuthContext, input: Input) {
    if ((await this.rows.countDocuments({ orgId: auth.orgId })) >= MAX) throw new ConflictException(`The library holds at most ${MAX} emails`);
    await this.unique(auth.orgId, input.name);
    const id = newId();
    const row = await this.rows.create({ id, orgId: auth.orgId, ...input, updatedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'email_template.created', targetType: 'email_template', targetId: id, after: { name: input.name } });
    return EmailTemplatesService.view(row);
  }

  async update(auth: AuthContext, id: string, input: Input) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id });
    if (!row) throw new NotFoundException('Email not found');
    await this.unique(auth.orgId, input.name, id);
    row.set({ ...input, updatedBy: auth.userId });
    await row.save();
    await this.audit.record(actorOf(auth), { action: 'email_template.saved', targetType: 'email_template', targetId: id, after: { name: input.name } });
    return EmailTemplatesService.view(row);
  }

  async remove(auth: AuthContext, id: string) {
    const gone = await this.rows.findOneAndDelete({ orgId: auth.orgId, id }).lean();
    if (!gone) throw new NotFoundException('Email not found');
    await this.audit.record(actorOf(auth), { action: 'email_template.deleted', targetType: 'email_template', targetId: id, before: { name: gone.name } });
  }
}

/** The organisation's saved emails. Everyone who works with forms or records can read them; administrators change them. */
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly templates: EmailTemplatesService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.templates.list(auth.orgId);
  }

  @Post()
  @RequirePermission('org.manage')
  create(@Auth() auth: AuthContext, @Body(new ZodBody(body)) input: Input) {
    return this.templates.create(auth, input);
  }

  @Put(':id')
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(body)) input: Input) {
    return this.templates.update(auth, idParam(id), input);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('org.manage')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.templates.remove(auth, idParam(id));
  }
}
