import { Controller, Get } from '@nestjs/common';
import { Auth, type AuthContext } from '../auth/auth-context';
import { PlansService } from './plans.service';

@Controller('org')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  /** The org's plan, its limits and current usage (every member may see it). */
  @Get('usage')
  usage(@Auth() auth: AuthContext) {
    return this.plans.usage(auth);
  }
}
