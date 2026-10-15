import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { ZodBody } from '../common/zod-body';
import { AiService } from './ai.service';

const draftBody = z.object({ description: z.string().max(4000), folderId: z.string().min(1).max(64) });

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status(@Auth() auth: AuthContext) {
    return this.ai.status(auth);
  }

  /** A draft of the form a description asks for: questions only, to create and edit as any draft. */
  @Post('form-drafts')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  draft(@Auth() auth: AuthContext, @Body(new ZodBody(draftBody)) body: z.infer<typeof draftBody>) {
    return this.ai.draftForm(auth, body);
  }
}
