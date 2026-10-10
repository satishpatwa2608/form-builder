import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../auth/auth.guard';
import { THROTTLE } from '../constants';
import { FormAutomationService } from '../services/form-automation.service';
import { FormThrottlerGuard } from './form-throttler.guard';

/**
 * Answering an approval from the link in its email, for forms that allow it. No sign-in: the key in the link is
 * the approver's alone. It travels in the body, not the address, so it stays out of access logs.
 */
@Public()
@Controller('public/approvals')
@UseGuards(FormThrottlerGuard)
export class ApprovalLinkController {
  constructor(private readonly automations: FormAutomationService) {}

  @Post('look')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  look(@Body() body: { key?: unknown }) {
    return this.automations.lookByKey(body?.key);
  }

  @Post('decide')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  decide(@Body() body: { key?: unknown; decision?: unknown; comment?: unknown }) {
    return this.automations.decideByKey(body?.key, body ?? {});
  }
}
