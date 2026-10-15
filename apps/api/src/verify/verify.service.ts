import { createHmac, randomInt } from 'node:crypto';
import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { needsCode, type FormDefinition, type FormValues } from '@fb/engine';
import type { Model } from 'mongoose';
import { hashToken, safeEqual } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { orgLog } from '../logs/org-log';
import { OrgMailService } from '../mail/org-mail.service';
import { FormDefinitionService } from '../work/services/form-definition.service';
import { FieldCode, type FieldCodeDocument } from './field-code.schema';
import { SmsService } from './sms.service';

const CODE_MINUTES = 10;
const PROOF_MINUTES = 60;
const MAX_SENDS_AN_HOUR = 5;
const MAX_TRIES = 5;
const fault = (field: string, message: string) => new BadRequestException({ message, errors: [{ field, message }] });

/** An address or number as it is compared: what was typed, tidied the same way every time. */
export function tidy(type: string, value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return type === 'EMAIL' ? text.toLowerCase() : text.replace(/[\s().-]/g, '');
}

/**
 * Confirming an email address or phone number typed into a form, with a one-time code sent to it. The form's
 * designer switches it on for a field; the person asks for a code, types it, and gets a proof that the server
 * requires when the form is submitted. A proof is for one value of one field of one form, for an hour.
 */
@Injectable()
export class VerifyService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly definitions: FormDefinitionService,
    private readonly mail: OrgMailService,
    private readonly sms: SmsService,
    @InjectModel(FieldCode.name) private readonly codes: Model<FieldCodeDocument>,
  ) {}

  private async target(orgId: string, formCode: string, fieldName: unknown, value: unknown) {
    const def = /^[A-Z0-9_]{1,100}$/.test(formCode) ? await this.definitions.findPublished(orgId, formCode) : null;
    const field = def?.fields.find((f) => f.name === fieldName);
    if (!def || !field || !needsCode(field)) throw new NotFoundException('Nothing here is confirmed with a code');
    const text = tidy(field.type, value);
    const ok = field.type === 'EMAIL' ? /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(text) : /^\+?[0-9]{7,15}$/.test(text);
    if (!ok) throw fault(field.name, field.type === 'EMAIL' ? 'Enter your email address first' : 'Enter your mobile number first, with its country code');
    return { def, field, text, valueHash: hashToken(`${orgId}|${formCode}|${field.name}|${text}`) };
  }

  /** Sends a code to what was typed. The answer is the same whether or not anything is known about that address. */
  async send(orgId: string, formCode: string, body: { field?: unknown; value?: unknown }) {
    const { def, field, text, valueHash } = await this.target(orgId, formCode, body.field, body.value);
    if ((await this.codes.countDocuments({ valueHash }).comment('across-orgs: codes sent to one address are counted wherever they were asked for, so no one is flooded')) >= MAX_SENDS_AN_HOUR) throw new HttpException('Too many codes have been sent here. Try again in an hour.', 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const words = `${code} is your code for "${def.name}". It works for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this message.`;
    if (field.type === 'EMAIL') await this.mail.send(orgId, { to: text, subject: `${code} is your code`, text: words });
    else await this.sms.send(orgId, text, words);
    await this.codes.create({ orgId, formCode, field: field.name, valueHash, codeHash: hashToken(`${valueHash}|${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000) });
    orgLog.debug(orgId, 'submissions', 'A confirmation code was sent', { form: formCode, field: field.name });
    return { sent: true, minutes: CODE_MINUTES };
  }

  /** Checks the code typed. Right: a proof to send with the form. Wrong five times: that code is spent. */
  async check(orgId: string, formCode: string, body: { field?: unknown; value?: unknown; code?: unknown }) {
    const { field, text, valueHash } = await this.target(orgId, formCode, body.field, body.value);
    const typed = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
    const row = await this.codes.findOne({ orgId, valueHash, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_TRIES } }).sort({ createdAt: -1 });
    if (!row) throw fault(field.name, 'That code has expired. Ask for a new one.');
    if (!/^[0-9]{6}$/.test(typed) || !safeEqual(row.codeHash, hashToken(`${valueHash}|${typed}`))) {
      await this.codes.updateOne({ _id: row._id, orgId }, { $inc: { attempts: 1 } });
      throw fault(field.name, row.attempts + 1 >= MAX_TRIES ? 'That code is not right. Ask for a new one.' : 'That code is not right. Check it and try again.');
    }
    // Spent: the same code cannot make a second proof.
    await this.codes.updateOne({ _id: row._id, orgId }, { $set: { attempts: MAX_TRIES } });
    return { proof: this.proofFor(orgId, formCode, field.name, text, Date.now() + PROOF_MINUTES * 60_000) };
  }

  private proofFor(orgId: string, formCode: string, field: string, text: string, until: number) {
    const signature = createHmac('sha256', this.config.JWT_SECRET).update(`field-proof|${orgId}|${formCode}|${field}|${text}|${until}`).digest('base64url');
    return `v1.${until}.${signature}`;
  }

  /** Every field that asks for a code, is on show and is filled in, must come with a proof for exactly what it holds. */
  missingProofs(orgId: string, def: FormDefinition, values: FormValues, visible: (name: string) => boolean, proofs: unknown): { field: string; message: string }[] {
    const given = proofs && typeof proofs === 'object' ? (proofs as Record<string, unknown>) : {};
    const out: { field: string; message: string }[] = [];
    for (const f of def.fields) {
      if (!needsCode(f) || !visible(f.name)) continue;
      const text = tidy(f.type, values[f.name]);
      if (!text) continue;
      const proof = typeof given[f.name] === 'string' ? (given[f.name] as string) : '';
      const [version, until] = proof.split('.');
      const good = version === 'v1' && Number(until) > Date.now() && safeEqual(proof, this.proofFor(orgId, def.code, f.name, text, Number(until)));
      if (!good) out.push({ field: f.name, message: f.type === 'EMAIL' ? 'Confirm this email address with the code we send to it' : 'Confirm this number with the code we send to it' });
    }
    return out;
  }
}
