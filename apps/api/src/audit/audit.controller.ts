import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { RequirePermission } from '../auth/auth.guard';
import { ZodBody } from '../common/zod-body';
import { AuditService } from './audit.service';

const query = z.object({
  action: z.string().max(60).optional(),
  actorId: z.string().max(64).optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Newest first; pass `next` back as `before` for the next page. */
  @Get()
  @RequirePermission('audit.read')
  list(@Auth() auth: AuthContext, @Query(new ZodBody(query)) q: z.infer<typeof query>) {
    return this.audit.list(auth.orgId, q);
  }
}
