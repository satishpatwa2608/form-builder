import { BadRequestException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import { OBJECT_STORE, type ObjectStore } from '../../common/object-store';
import type { FormDefinition, FormField } from '@fb/engine';
import { LIMITS } from '../constants';
import { mimeAllowed, SNIFF_BYTES, sniffFileType } from '../security/file-sniff';
import { FormUpload, FormUploadDocument } from '../schemas/upload.schema';
import type { SubmissionFile } from '../schemas/form-submission.schema';

const DEFAULT_ACCEPT = ['image/*', 'application/pdf'];
const DEFAULT_MAX_MB = 5;

/**
 * Form attachments: browser -> PRIVATE S3 bucket via short-lived pre-signed
 * PUT (size and type pinned in the signature), then the server reads the
 * first bytes and checks the real type before the file can be attached.
 *
 * Storage is an ObjectStore: S3 in production (IAM role, private bucket),
 * local disk in development. Unattached objects live under `.../pending/`;
 * add an S3 lifecycle rule expiring that prefix after 1 day.
 */
@Injectable()
export class FormUploadService {
  private readonly logger = new Logger(FormUploadService.name);

  constructor(
    @InjectModel(FormUpload.name) private readonly uploads: Model<FormUploadDocument>,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  private static rules(field: FormField) {
    const accept = Array.isArray(field.props?.accept) ? (field.props!.accept as string[]) : DEFAULT_ACCEPT;
    const maxMB = Math.min(typeof field.props?.maxSizeMB === 'number' ? (field.props.maxSizeMB as number) : DEFAULT_MAX_MB, LIMITS.maxUploadMB);
    return { accept, maxBytes: maxMB * 1024 * 1024, maxFiles: field.validation?.max ?? 1 };
  }

  private static fileField(def: FormDefinition, fieldName: unknown): FormField {
    const field = def.fields.find((f) => f.name === fieldName && f.type === 'FILE');
    if (!field) throw new BadRequestException('This form has no such file field');
    return field;
  }

  /** Name safe for an S3 key and a download header. */
  private static safeName(name: string) {
    const base = name.split(/[\\/]/).pop() ?? 'file';
    return base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  }

  /** Step 1: a pre-signed PUT for one file, after checking the declared type/size against the field. */
  async presign(orgId: string, def: FormDefinition, body: Record<string, unknown>) {
    const field = FormUploadService.fileField(def, body.fieldName);
    const { accept, maxBytes } = FormUploadService.rules(field);
    const name = typeof body.fileName === 'string' ? body.fileName : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : '';
    const size = typeof body.size === 'number' ? body.size : -1;
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';

    if (!name || !/^[a-z]+\/[a-z0-9.+-]+$/.test(contentType)) throw new BadRequestException('Invalid file');
    if (size <= 0 || size > maxBytes) throw new BadRequestException(`Files must be at most ${Math.round(maxBytes / 1048576)} MB`);
    if (!mimeAllowed({ mime: contentType, ext }, accept)) throw new BadRequestException('This file type is not allowed');

    const uuid = uuidv4();
    const key = `form-uploads/${orgId}/${def.code}/pending/${uuid}/${FormUploadService.safeName(name)}`;
    const { url, headers } = await this.store.presignPut(key, contentType, size);
    await this.uploads.create({
      uuid,
      orgId,
      formCode: def.code,
      fieldName: field.name,
      key,
      name: FormUploadService.safeName(name),
      size,
      contentType,
      accept,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    });
    return { uploadId: uuid, url, headers };
  }

  /** Step 2: read the first bytes from S3 and confirm the real type; mismatches are deleted. */
  async verify(orgId: string, uploadId: string) {
    const upload = await this.uploads.findOne({ uuid: uploadId, orgId });
    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.status === 'VERIFIED') return { uploadId, name: upload.name, size: upload.size, contentType: upload.contentType };
    if (upload.status !== 'PENDING') throw new UnprocessableEntityException('This upload was rejected');

    let head: Buffer;
    try {
      head = await this.store.readHead(upload.key, SNIFF_BYTES);
    } catch {
      throw new UnprocessableEntityException('The file was not uploaded');
    }

    // The real type (from the bytes) must satisfy the field's accept list - the declared type is only a claim.
    const detected = await sniffFileType(head);
    if (!detected || !mimeAllowed(detected, upload.accept)) {
      await this.store.remove(upload.key);
      upload.status = 'REJECTED';
      await upload.save();
      this.logger.warn(`upload ${uploadId} rejected: declared ${upload.contentType}, detected ${detected?.mime ?? 'unknown'}`);
      throw new UnprocessableEntityException("The file's content doesn't match its type");
    }
    upload.status = 'VERIFIED';
    upload.contentType = detected!.mime;
    await upload.save();
    return { uploadId, name: upload.name, size: upload.size, contentType: upload.contentType };
  }

  /** Before storing a submission: every referenced upload must be verified and belong to this form/field. */
  async checkAttachable(orgId: string, def: FormDefinition, fieldName: string, uploadIds: string[]) {
    const field = FormUploadService.fileField(def, fieldName);
    const { maxFiles } = FormUploadService.rules(field);
    if (uploadIds.length > maxFiles) throw new BadRequestException(`At most ${maxFiles} file(s) for ${field.label || field.name}`);
    const rows = await this.uploads.find({ uuid: { $in: uploadIds }, orgId, formCode: def.code, fieldName, status: 'VERIFIED' }).lean();
    if (rows.length !== new Set(uploadIds).size) throw new BadRequestException('One or more files are missing or were not verified');
    return rows;
  }

  /** After storing: move files out of `pending/` to the submission's folder and mark them attached. */
  async attach(submissionId: string, uploads: FormUpload[]): Promise<SubmissionFile[]> {
    const files: SubmissionFile[] = [];
    for (const u of uploads) {
      const key = u.key.replace(/\/pending\/[^/]+\//, `/${submissionId}/${u.uuid}-`);
      await this.store.move(u.key, key);
      await this.uploads.updateOne({ uuid: u.uuid }, { $set: { status: 'ATTACHED', key } });
      files.push({ fieldName: u.fieldName, uploadId: u.uuid, key, name: u.name, size: u.size, contentType: u.contentType });
    }
    return files;
  }

  /** Short-lived link for an authorised viewer. */
  async downloadUrl(key: string, name: string) {
    return this.store.presignGet(key, FormUploadService.safeName(name));
  }
}
