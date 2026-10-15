import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp, logsAsJson } from './bootstrap';
import { JsonLogger } from './common/json-logger';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bufferLogs: true });
  if (logsAsJson(config)) app.useLogger(new JsonLogger('api'));
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}
void bootstrap();
