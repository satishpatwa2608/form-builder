import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { RecordAccess } from '@fb/engine';
import type { Model } from 'mongoose';
import { isAllowed } from '../../access/roles';
import { User, type UserDocument } from '../../auth/auth.schemas';
import { Membership, type MembershipDocument } from '../../orgs/org.schemas';

export interface Person {
  uuid: string;
  name: string;
  email: string;
  department?: string;
}

/** Away now: a start that has passed, and an end (if any) that has not. */
export function isAway(m: { awayFrom?: Date | null; awayUntil?: Date | null }, now = new Date()): boolean {
  return !!m.awayFrom && m.awayFrom <= now && (!m.awayUntil || m.awayUntil > now);
}

/** Who's who for work items, from memberships (role, department, manager) and users (name, email). */
@Injectable()
export class PeopleService {
  constructor(
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  /** Active members who can work records (the only people records can go to); a team narrows it. */
  async workers(orgId: string, uuids?: string[], search?: string, team?: RecordAccess): Promise<Person[]> {
    const members = (await this.memberships.find({ orgId, status: 'ACTIVE', ...(uuids ? { userId: { $in: uuids } } : {}) }).lean()).filter((m) => isAllowed(m.role, [], 'record.work'));
    const inTeam = (m: (typeof members)[number]) => !team || team.userIds.includes(m.userId) || (!!m.department && team.departments.includes(m.department));
    const byId = new Map(members.filter(inTeam).map((m) => [m.userId, m]));
    const q = search?.toLowerCase();
    const users = await this.users.find({ id: { $in: [...byId.keys()] } }).select('id name email').lean();
    return users
      .filter((u) => !q || u.name.toLowerCase().includes(q))
      .map((u) => ({ uuid: u.id, name: u.name, email: u.email, department: byId.get(u.id)?.department || undefined }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
  }

  /** Name and email for any members (submitters needn't be record workers). */
  async contacts(orgId: string, uuids: string[]): Promise<Map<string, Person>> {
    const ids = [...new Set(uuids.filter(Boolean))];
    if (!ids.length) return new Map();
    const memberIds = (await this.memberships.find({ orgId, userId: { $in: ids } }).select('userId').lean()).map((m) => m.userId);
    const users = await this.users.find({ id: { $in: memberIds } }).select('id name email').lean();
    return new Map(users.map((u) => [u.id, { uuid: u.id, name: u.name, email: u.email }]));
  }

  async managerOf(orgId: string, userId: string): Promise<string> {
    if (!userId) return '';
    const m = await this.memberships.findOne({ orgId, userId, status: 'ACTIVE' }).select('managerId').lean();
    return m?.managerId ?? '';
  }

  /**
   * Who gets what was meant for `userId` right now: themselves, or, while they are away, the person they named
   * (and so on along the chain). A chain that comes back round, or ends at someone who cannot work records,
   * leaves the work with the person it was meant for, so nothing is ever handed to no one.
   */
  async standIn(orgId: string, userId: string, now = new Date()): Promise<{ userId: string; awayFor: string[] }> {
    const seen: string[] = [];
    let current = userId;
    for (let hop = 0; current && hop < 10; hop++) {
      const m = await this.memberships.findOne({ orgId, userId: current, status: 'ACTIVE' }).select('role awayFrom awayUntil awayTo').lean();
      if (!m || !isAllowed(m.role, [], 'record.work')) return hop ? { userId, awayFor: [] } : { userId: current, awayFor: [] };
      if (!isAway(m, now) || !m.awayTo) return { userId: current, awayFor: seen };
      seen.push(current);
      if (seen.includes(m.awayTo)) return { userId, awayFor: [] };
      current = m.awayTo;
    }
    return { userId, awayFor: [] };
  }

  /** Each of these people, or whoever stands in for them while they are away; no one twice. */
  async present(orgId: string, userIds: string[], now = new Date()): Promise<string[]> {
    const out: string[] = [];
    for (const id of userIds) out.push((await this.standIn(orgId, id, now)).userId);
    return [...new Set(out.filter(Boolean))];
  }

  /** The people who share their list with this person: what they hold, this person may see and open too. */
  async sharingWith(orgId: string, userId: string): Promise<string[]> {
    if (!userId) return [];
    return (await this.memberships.find({ orgId, sharedWith: userId, status: 'ACTIVE' }).select('userId').limit(500).lean()).map((m) => m.userId);
  }

  /** The people whose manager this is. */
  async reportsOf(orgId: string, managerId: string): Promise<string[]> {
    if (!managerId) return [];
    return (await this.memberships.find({ orgId, managerId, status: 'ACTIVE' }).select('userId').limit(500).lean()).map((m) => m.userId);
  }

  async department(orgId: string, userId: string): Promise<string | undefined> {
    const m = await this.memberships.findOne({ orgId, userId }).select('department').lean();
    return m?.department || undefined;
  }
}
