import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { RequirePermission } from '../auth/auth.guard';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { ZodBody } from '../common/zod-body';
import { AiService } from './ai.service';

const draftBody = z.object({ description: z.string().max(4000), folderId: z.string().min(1).max(64) });
const keyBody = z.object({ key: z.string().max(400) });

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status(@Auth() auth: AuthContext) {
    return this.ai.status(auth);
  }

  /** The organisation's own AI key: it pays for what it uses. Checked, then kept sealed; never shown again. */
  @Put('key')
  @RequirePermission('org.manage')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setKey(@Auth() auth: AuthContext, @Body(new ZodBody(keyBody)) body: z.infer<typeof keyBody>) {
    return this.ai.setKey(auth, body.key);
  }

  @Delete('key')
  @RequirePermission('org.manage')
  removeKey(@Auth() auth: AuthContext) {
    return this.ai.removeKey(auth);
  }

  /** A draft of the form a description asks for: questions only, to create and edit as any draft. */
  @Post('form-drafts')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  draft(@Auth() auth: AuthContext, @Body(new ZodBody(draftBody)) body: z.infer<typeof draftBody>) {
    return this.ai.draftForm(auth, body);
  }
}
