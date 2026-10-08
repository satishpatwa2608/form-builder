import { Controller, Get } from '@nestjs/common';
import { CONNECTOR_TYPES } from '@fb/connectors';
import { Public } from './auth/auth.guard';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  health() {
    return { status: 'ok', service: 'api', connectors: CONNECTOR_TYPES };
  }
}
