import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import { OBJECT_STORE, type ObjectStore } from '../../common/object-store';
import type { FormDefinition, FormField } from '@fb/engine';
import { LIMITS } from '../constants';
import { mimeAllowed, SNIFF_BYTES, sniffFileType } from '../security/file-sniff';
import { FILE_SCANNER, type FileScanner } from '../security/file-scanner';
import { FormUpload, FormUploadDocument } from '../schemas/upload.schema';
import type { SubmissionFile } from '../schemas/form-submission.schema';

const DEFAULT_ACCEPT = ['image/*', 'application/pdf'];
const DEFAULT_MAX_MB = 5;

/**
 * Form attachments: browser -> PRIVATE S3 bucket via short-lived pre-signed
 * PUT (size and type pinned in the signature), then the server reads the
 * first bytes and checks the real type, and has the file scanned for malware,
 * before it can be attached.
 *
 * Storage is an ObjectStore: S3 in production (IAM role, private bucket),
 * local disk in development. Unattached objects live under `.../pending/`;
 * add an S3 lifecycle rule expiring that prefix after 1 day.
 */
/** Where a form field's name would be, for files staff add to a record. No field can have this name. */
export const STAFF_FIELD = '$staff';

@Injectable()
export class FormUploadService {
  private readonly logger = new Logger(FormUploadService.name);

  constructor(
    @InjectModel(FormUpload.name) private readonly uploads: Model<FormUploadDocument>,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
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

  /**
   * A file staff add to a record while working it (a letter received, a photo from a site visit). It goes
   * through the same steps as a respondent's file: declared type and size, then the real type and the malware
   * check, before it is attached. `STAFF_FIELD` stands where a form field's name would.
   */
  presignForStaff(orgId: string, formCode: string, body: Record<string, unknown>) {
    return this.presignAs(orgId, formCode, STAFF_FIELD, { accept: DEFAULT_ACCEPT, maxBytes: Math.min(DEFAULT_MAX_MB, LIMITS.maxUploadMB) * 1024 * 1024 }, body);
  }

  /** The verified upload a member of staff is adding to a record of this form, or a refusal. */
  async staffUpload(orgId: string, formCode: string, uploadId: string): Promise<FormUpload> {
    await this.verify(orgId, uploadId);
    const row = await this.uploads.findOne({ uuid: uploadId, orgId, formCode, fieldName: STAFF_FIELD, status: 'VERIFIED' }).lean();
    if (!row) throw new BadRequestException('That file is missing or was not verified');
    return row;
  }

  /** Step 1: a pre-signed PUT for one file, after checking the declared type/size against the field. */
  async presign(orgId: string, def: FormDefinition, body: Record<string, unknown>) {
    const field = FormUploadService.fileField(def, body.fieldName);
    return this.presignAs(orgId, def.code, field.name, FormUploadService.rules(field), body);
  }

  private async presignAs(orgId: string, formCode: string, fieldName: string, { accept, maxBytes }: { accept: string[]; maxBytes: number }, body: Record<string, unknown>) {
    const name = typeof body.fileName === 'string' ? body.fileName : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType.toLowerCase() : '';
    const size = typeof body.size === 'number' ? body.size : -1;
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';

    if (!name || !/^[a-z]+\/[a-z0-9.+-]+$/.test(contentType)) throw new BadRequestException('Invalid file');
    if (size <= 0 || size > maxBytes) throw new BadRequestException(`Files must be at most ${Math.round(maxBytes / 1048576)} MB`);
    if (!mimeAllowed({ mime: contentType, ext }, accept)) throw new BadRequestException('This file type is not allowed');

    const uuid = uuidv4();
    const key = `form-uploads/${orgId}/${formCode}/pending/${uuid}/${FormUploadService.safeName(name)}`;
    const { url, headers } = await this.store.presignPut(key, contentType, size);
    await this.uploads.create({
      uuid,
      orgId,
      formCode,
      fieldName,
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
    // Then the malware check, on the whole file. No answer means no: the upload stays unverified and can be tried again.
    let verdict;
    try {
      verdict = await this.scanner.scan(await this.store.readHead(upload.key, upload.size));
    } catch (e) {
      this.logger.error(`upload ${uploadId} could not be scanned: ${(e as Error).message}`);
      throw new ServiceUnavailableException('The file could not be checked just now. Please try again.');
    }
    if (!verdict.clean) {
      await this.store.remove(upload.key);
      upload.status = 'REJECTED';
      await upload.save();
      this.logger.warn(`upload ${uploadId} rejected by ${this.scanner.name}: ${verdict.threat}`);
      throw new UnprocessableEntityException('This file was blocked because it may be harmful');
    }
    upload.status = 'VERIFIED';
    upload.contentType = detected!.mime;
    upload.scannedBy = this.scanner.name;
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

  /**
   * The bytes of what a respondent uploaded with one response, for copying to the organisation's own storage:
   * as many as fit in `room` bytes together, smallest first, and how many could not be taken.
   */
  async copiesOf(orgId: string, uploadIds: string[], room: number): Promise<{ files: { name: string; type: string; content: Buffer }[]; leftOut: number }> {
    const rows = uploadIds.length ? await this.uploads.find({ orgId, uuid: { $in: uploadIds.slice(0, 100) }, status: 'ATTACHED' }).sort({ size: 1 }).lean() : [];
    const files: { name: string; type: string; content: Buffer }[] = [];
    let left = room;
    let leftOut = uploadIds.length - rows.length;
    for (const u of rows) {
      const content = u.size <= left ? await this.store.get(u.key).catch(() => null) : null;
      if (!content || content.length > left) {
        leftOut++;
        continue;
      }
      left -= content.length;
      files.push({ name: u.name, type: u.contentType, content });
    }
    return { files, leftOut };
  }

  /** Short-lived link for an authorised viewer. */
  async downloadUrl(key: string, name: string) {
    return this.store.presignGet(key, FormUploadService.safeName(name));
  }
}
