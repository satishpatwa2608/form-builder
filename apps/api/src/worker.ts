import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { JobQueue } from './jobs/job-queue.service';

/**
 * The worker: the same application as the API, without an HTTP server. It
 * takes jobs (automations, webhook deliveries) from the queue and runs the
 * SLA sweep, so that work never competes with requests and survives an API
 * restart. Run the API beside it with JOBS_ROLE=enqueue.
 */
async function bootstrap() {
  const config = loadConfig({ ...process.env, JOBS_ROLE: 'run' });
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config));
  app.enableShutdownHooks();
  const waiting = await app.get(JobQueue).counts();
  new Logger('Worker').log(`Worker started - ${waiting.PENDING ?? 0} job(s) waiting`);
}
void bootstrap();
