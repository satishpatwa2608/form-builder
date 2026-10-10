import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { CONNECTOR_TYPES } from '@fb/connectors';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { ConnectorsService } from './connectors.service';

const name = z.string().trim().min(1).max(80);
const hosts = z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(20);
const createBody = z.object({
  type: z.enum(CONNECTOR_TYPES),
  name,
  settings: z.record(z.string(), z.unknown()),
  // Absent for gateway connectors: their credentials stay on the agent.
  secrets: z.record(z.string(), z.unknown()).default({}),
  writable: z.boolean().optional(),
  allowedHosts: hosts.optional(),
  gatewayId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
});
const updateBody = z.object({ name: name.optional(), settings: z.record(z.string(), z.unknown()).optional(), writable: z.boolean().optional(), allowedHosts: hosts.optional() });
const secretsBody = z.object({ secrets: z.record(z.string(), z.unknown()) });
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const entitiesBody = z.object({
  entities: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/),
        label: z.string().trim().min(1).max(80),
        fields: z.array(ident).max(100),
        keyField: z.union([ident, z.literal('')]).default(''),
        operations: z.array(z.enum(['list', 'get', 'lookup', 'insert', 'update', 'upload', 'log'])).max(7),
        valueField: z.union([ident, z.literal('')]).default(''),
        labelField: z.union([ident, z.literal('')]).default(''),
        about: z
          .array(z.object({ name: ident, type: z.enum(['string', 'number', 'boolean', 'date', 'object', 'array', 'unknown']).optional(), nullable: z.boolean().optional(), maxLength: z.number().int().positive().max(100_000).optional(), hasDefault: z.boolean().optional() }))
          .max(100)
          .default([]),
      }),
    )
    .max(100),
});
const tryInsertBody = z.object({ entity: z.string().max(120), values: z.record(z.string().max(100), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()])) });
const queryBody = z.object({ key: z.string().max(200), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}) });

/** Permissions are per connector (org role or a connector grant), checked in the service. */
@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get('types')
  types() {
    return this.connectors.types();
  }

  /** Static routes before :id. */
  @Get('sources')
  sources(@Auth() auth: AuthContext) {
    return this.connectors.sources(auth);
  }

  @Post('query')
  @HttpCode(200)
  query(@Auth() auth: AuthContext, @Body(new ZodBody(queryBody)) body: z.infer<typeof queryBody>) {
    return this.connectors.querySource(auth, body.key, body.params);
  }

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.connectors.list(auth);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodBody(createBody)) body: z.infer<typeof createBody>) {
    return this.connectors.create(auth, body);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.connectors.get(auth, idParam(id));
  }

  @Patch(':id')
  update(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(updateBody)) body: z.infer<typeof updateBody>) {
    return this.connectors.update(auth, idParam(id), body);
  }

  @Put(':id/secrets')
  rotate(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(secretsBody)) body: z.infer<typeof secretsBody>) {
    return this.connectors.rotateSecrets(auth, idParam(id), body.secrets);
  }

  @Delete(':id')
  remove(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.connectors.remove(auth, idParam(id));
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.connectors.test(auth, idParam(id));
  }

  /** Try a write: one real row added to an exposed table, by whoever manages the connector. */
  @Post(':id/try-insert')
  @HttpCode(200)
  tryInsert(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(tryInsertBody)) body: z.infer<typeof tryInsertBody>) {
    return this.connectors.tryInsert(auth, idParam(id), body.entity, body.values);
  }

  @Post(':id/discover')
  @HttpCode(200)
  discover(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.connectors.discover(auth, idParam(id));
  }

  @Put(':id/entities')
  entities(@Auth() auth: AuthContext, @Param('id') id: string, @Body(new ZodBody(entitiesBody)) body: z.infer<typeof entitiesBody>) {
    return this.connectors.setEntities(auth, idParam(id), body.entities);
  }

  @Get(':id/calls')
  calls(@Auth() auth: AuthContext, @Param('id') id: string) {
    return this.connectors.callLog(auth, idParam(id));
  }
}
