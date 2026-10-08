import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import apiResponse from '../response';
import type { WorkingCalendar } from '@fb/engine';
import { DEFAULT_CALENDAR } from '@fb/engine';
import { FormCalendar, FormCalendarDocument } from '../schemas/form-record.schema';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The org's working-time calendar for SLAs counted in working hours. */
@Injectable()
export class FormCalendarService {
  private readonly cache = new Map<string, { at: number; cal: WorkingCalendar }>();

  constructor(@InjectModel(FormCalendar.name) private readonly model: Model<FormCalendarDocument>) {}

  async get(orgId: string): Promise<WorkingCalendar> {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < 60_000) return hit.cal;
    const row = await this.model.findOne({ orgId }).lean();
    const cal: WorkingCalendar = row
      ? { workingDays: row.workingDays, start: row.start, end: row.end, holidays: row.holidays, utcOffsetMinutes: row.utcOffsetMinutes }
      : DEFAULT_CALENDAR;
    this.cache.set(orgId, { at: Date.now(), cal });
    return cal;
  }

  async read(user: { orgId: string }) {
    return apiResponse(true, 200, 'Calendar fetched', await this.get(user.orgId));
  }

  async save(user: { orgId: string; uuid: string }, body: Partial<WorkingCalendar>) {
    const days = Array.isArray(body?.workingDays) ? [...new Set(body.workingDays)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : null;
    if (!days?.length) throw new BadRequestException('Pick at least one working day');
    if (!HHMM.test(String(body.start)) || !HHMM.test(String(body.end)) || String(body.end) <= String(body.start)) {
      throw new BadRequestException('Working hours are HH:MM, with the end after the start');
    }
    const holidays = Array.isArray(body.holidays) ? [...new Set(body.holidays.filter((h) => typeof h === 'string' && DATE.test(h)))].sort().slice(0, 400) : [];
    const offset = Number(body.utcOffsetMinutes);
    if (!Number.isInteger(offset) || offset < -720 || offset > 840) throw new BadRequestException('Invalid UTC offset');
    const cal: WorkingCalendar = { workingDays: days, start: String(body.start), end: String(body.end), holidays, utcOffsetMinutes: offset };
    await this.model.updateOne({ orgId: user.orgId }, { $set: { ...cal, updatedBy: user.uuid } }, { upsert: true });
    this.cache.delete(user.orgId);
    return apiResponse(true, 200, 'Calendar saved', cal);
  }
}
