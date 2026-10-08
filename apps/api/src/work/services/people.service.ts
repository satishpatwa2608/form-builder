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

  async department(orgId: string, userId: string): Promise<string | undefined> {
    const m = await this.memberships.findOne({ orgId, userId }).select('department').lean();
    return m?.department || undefined;
  }
}
