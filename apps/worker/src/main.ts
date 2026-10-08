import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/** No HTTP: a Nest application context that consumes the job queue (SQS in Phase 1b). */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker started - no queues attached yet (Phase 1b)');
}
void bootstrap();
