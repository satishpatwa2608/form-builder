import { SsoController } from './sso/sso.controller';
import { SsoService } from './sso/sso.service';
import { SsoState, SsoStateSchema } from './sso/sso.schema';
import { DraftsService } from './drafts/drafts.service';
import { FormDraft, FormDraftSchema } from './drafts/draft.schema';
import { DNS_TXT, SiteService, systemTxtResolver } from './site/site.service';
import { SiteController, SitePublicController } from './site/site.controller';
import { PlansController } from './plans/plans.controller';
import { PlansService } from './plans/plans.service';
import { FormStat, FormStatSchema, UsageMonth, UsageMonthSchema, FormFieldStat, FormFieldStatSchema } from './plans/usage.schema';
import type { Connection } from 'mongoose';
import { orgScopePlugin } from './common/org-scope';
import { Module, type DynamicModule } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessController } from './access/access.controller';
import { Folder, FolderSchema, Grant, GrantSchema } from './access/access.schemas';
import { AccessService } from './access/access.service';
import { PermissionService } from './access/permission.service';
import { AuditController } from './audit/audit.controller';
import { AuditEntry, AuditEntrySchema } from './audit/audit.schema';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthToken, AuthTokenSchema, Session, SessionSchema, User, UserSchema } from './auth/auth.schemas';
import { AuthService } from './auth/auth.service';
import { MAILER, mailerFor } from './common/mailer';
import { LocalObjectStore, OBJECT_STORE, S3ObjectStore } from './common/object-store';
import { APP_CONFIG, type AppConfig } from './config';
import { Form, FormSchema } from './forms/form.schema';
import { FormsController } from './forms/forms.controller';
import { FormsService } from './forms/forms.service';
import { HealthController } from './health.controller';
import { Connector, ConnectorCall, ConnectorCallSchema, ConnectorSchema } from './connectors/connector.schema';
import { ConnectorsController, ConnectorSignInController } from './connectors/connectors.controller';
import { ConnectorsService } from './connectors/connectors.service';
import { Gateway, GatewayCall, GatewayCallSchema, GatewaySchema } from './gateways/gateway.schema';
import { GatewaysController } from './gateways/gateways.controller';
import { GatewaysService } from './gateways/gateways.service';
import { KEY_PROVIDER, KmsKeyProvider, LocalKeyProvider } from './common/key-provider';
import { Style, StyleSchema } from './styles/style.schema';
import { StylesController } from './styles/styles.controller';
import { StylesService } from './styles/styles.service';
import { FormPublicController } from './work/controllers/form-public.controller';
import { FormRecordController } from './work/controllers/form-record.controller';
import { LocalStoreController } from './work/controllers/local-store.controller';
import { NotificationsController } from './work/controllers/notifications.controller';
import { Notification, NotificationSchema } from './work/schemas/notification.schema';
import {
  FormCalendar,
  FormCalendarSchema,
  FormCounter,
  FormCounterSchema,
  FormFlowRun,
  FormFlowRunSchema,
  FormRecordEvent,
  FormRecordEventSchema,
  FormWebhook,
  FormWebhookSchema,
  FormWorkSettings,
  FormWorkSettingsSchema,
  FormWorkView,
  FormWorkViewSchema,
} from './work/schemas/form-record.schema';
import { FormSubmission, FormSubmissionSchema } from './work/schemas/form-submission.schema';
import { FormRateLimit, FormRateLimitSchema, FormUpload, FormUploadSchema } from './work/schemas/upload.schema';
import { CaptchaVerifierService } from './work/services/captcha-verifier.service';
import { DataSourceQueryService } from './work/services/data-source-query.service';
import { OpenWithService } from './work/services/open-with.service';
import { FormAutomationService } from './work/services/form-automation.service';
import { Job, JobSchema } from './jobs/job.schema';
import { SharedWorkflowRow, SharedWorkflowSchema } from './workflows/workflow.schema';
import { WorkflowsService } from './workflows/workflows.service';
import { WorkflowsController } from './workflows/workflows.controller';
import { FormComment, FormCommentSchema } from './forms/form-comment.schema';
import { FormReviewService } from './forms/form-review.service';
import { FormReviewController } from './forms/form-review.controller';
import { DocumentBatch, DocumentBatchSchema } from './documents/document-batch.schema';
import { DocumentsService } from './documents/documents.service';
import { DocumentsController } from './documents/documents.controller';
import { PdfTemplate, PdfTemplateSchema, PdfTemplatesController, PdfTemplatesService } from './documents/pdf-template';
import { OrgSeal, OrgSealSchema, SealController, SealService } from './documents/seal.service';
import { SignatureRequest, SignatureRequestSchema } from './signatures/signature.schema';
import { SignaturesService } from './signatures/signatures.service';
import { PortalService } from './portal/portal.service';
import { OrgMailService } from './mail/org-mail.service';
import { CheckoutPublicController, CheckoutSettingsController } from './payments/checkout.controller';
import { Payment, PaymentSchema } from './payments/payment.schema';
import { PaymentsService } from './payments/payments.service';
import { FieldCode, FieldCodeSchema } from './verify/field-code.schema';
import { SmsService } from './verify/sms.service';
import { VerifyService } from './verify/verify.service';
import { OrgLogService } from './logs/org-log.service';
import { OperatorService } from './operator/operator.service';
import { EcrImageStore, ExtensionDeployService, IMAGE_STORE } from './extensions/extension-deploy.service';
import { ExtensionDeploy, ExtensionDeploySchema } from './extensions/extension-deploy.schema';
import { ExtensionDeployKey, ExtensionDeployKeySchema } from './extensions/extension-deploy-key.schema';
import { ExtensionPipelineController } from './extensions/extension-pipeline.controller';
import { ExtensionBuildController, ExtensionRepoController } from './extensions/extension-repo.controller';
import { ExtensionBuild, ExtensionBuildSchema, ExtensionRepo, ExtensionRepoSchema } from './extensions/extension-repo.schema';
import { BUILD_RUNNER, CodeBuildRunner, ExtensionRepoService, GIT_REMOTE, GitCli } from './extensions/extension-repo.service';
import { OperatorController } from './operator/operator.controller';
import { OrgLogController } from './logs/org-log.controller';
import { OrgLog, OrgLogSchema } from './logs/log.schema';
import { OrgMailController } from './mail/org-mail.controller';
import { PortalController } from './portal/portal.controller';
import { ApprovalLinkController } from './work/controllers/approval-link.controller';
import { PortalPass, PortalPassSchema } from './portal/portal.schema';
import { SignaturePublicController, SignaturesController } from './signatures/signatures.controller';
import { FragmentRow, FragmentSchema } from './fragments/fragment.schema';
import { FragmentsService } from './fragments/fragments.service';
import { FragmentsController } from './fragments/fragments.controller';
import { SharedList, SharedListSchema } from './lists/list.schema';
import { ListsService } from './lists/lists.service';
import { ListsController } from './lists/lists.controller';
import { EmailTemplateRow, EmailTemplateSchema, EmailTemplatesController, EmailTemplatesService } from './email-templates/email-templates';
import { ExtensionRow, ExtensionSchema } from './extensions/extension.schema';
import { ExtensionsService } from './extensions/extensions.service';
import { ExtensionsController } from './extensions/extensions.controller';
import { ExtensionPublicController } from './extensions/extension-public.controller';
import { JobQueue } from './jobs/job-queue.service';
import { FormCalendarService } from './work/services/form-calendar.service';
import { FormContextService } from './work/services/form-context.service';
import { FormDefinitionService } from './work/services/form-definition.service';
import { FormRecordService } from './work/services/form-record.service';
import { FormSubmissionService } from './work/services/form-submission.service';
import { FormUploadService } from './work/services/form-upload.service';
import { ClamAvScanner, FILE_SCANNER, NoFileScanner } from './work/security/file-scanner';
import { FormWebhookService } from './work/services/form-webhook.service';
import { FormHandlerRegistry } from './work/services/form-workflow.registry';
import { MailService } from './work/services/mail.service';
import { MongoThrottlerStorage } from './work/services/mongo-throttler.storage';
import { NotificationsService } from './work/services/notifications.service';
import { PeopleService } from './work/services/people.service';
import { WorkItemService } from './work/services/work-item.service';
import { WorkPortalService } from './work/services/work-portal.service';
import { Invitation, InvitationSchema, Membership, MembershipSchema, Organization, OrganizationSchema } from './orgs/org.schemas';
import { OrgsController } from './orgs/orgs.controller';
import { OrgsService } from './orgs/orgs.service';

/** Rate-limit counters in MongoDB, shared by every API instance (in its own module so the throttler factory can inject it). */
function rateLimitModule(): DynamicModule {
  return {
    module: class RateLimitModule {},
    imports: [MongooseModule.forFeature([{ name: FormRateLimit.name, schema: FormRateLimitSchema }])],
    providers: [MongoThrottlerStorage],
    exports: [MongoThrottlerStorage],
  };
}

@Module({})
export class AppModule {
  /** Built from validated config so tests can run the real app against an in-memory Mongo. */
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        MongooseModule.forRoot(config.MONGODB_URL, {
          autoIndex: true,
          // Every query on an organisation's data must say which organisation it is for (common/org-scope.ts).
          connectionFactory: (connection: Connection) => {
            connection.plugin(orgScopePlugin);
            return connection;
          },
        }),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Session.name, schema: SessionSchema },
          { name: AuthToken.name, schema: AuthTokenSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: Membership.name, schema: MembershipSchema },
          { name: Invitation.name, schema: InvitationSchema },
          { name: Folder.name, schema: FolderSchema },
          { name: Grant.name, schema: GrantSchema },
          { name: AuditEntry.name, schema: AuditEntrySchema },
          { name: Form.name, schema: FormSchema },
          { name: Style.name, schema: StyleSchema },
          { name: FormSubmission.name, schema: FormSubmissionSchema },
          { name: PdfTemplate.name, schema: PdfTemplateSchema },
          { name: OrgSeal.name, schema: OrgSealSchema },
          { name: FormUpload.name, schema: FormUploadSchema },
          { name: FormRecordEvent.name, schema: FormRecordEventSchema },
          { name: FormCounter.name, schema: FormCounterSchema },
          { name: FormFlowRun.name, schema: FormFlowRunSchema },
          { name: FormCalendar.name, schema: FormCalendarSchema },
          { name: FormWebhook.name, schema: FormWebhookSchema },
          { name: FormWorkView.name, schema: FormWorkViewSchema },
          { name: FormWorkSettings.name, schema: FormWorkSettingsSchema },
          { name: Notification.name, schema: NotificationSchema },
          { name: Connector.name, schema: ConnectorSchema },
          { name: ConnectorCall.name, schema: ConnectorCallSchema },
          { name: Gateway.name, schema: GatewaySchema },
          { name: GatewayCall.name, schema: GatewayCallSchema },
          { name: UsageMonth.name, schema: UsageMonthSchema },
          { name: FormStat.name, schema: FormStatSchema },
          { name: FormFieldStat.name, schema: FormFieldStatSchema },
          { name: PortalPass.name, schema: PortalPassSchema },
          { name: OrgLog.name, schema: OrgLogSchema },
          { name: ExtensionDeploy.name, schema: ExtensionDeploySchema },
          { name: Payment.name, schema: PaymentSchema },
          { name: FieldCode.name, schema: FieldCodeSchema },
          { name: ExtensionDeployKey.name, schema: ExtensionDeployKeySchema },
          { name: ExtensionRepo.name, schema: ExtensionRepoSchema },
          { name: ExtensionBuild.name, schema: ExtensionBuildSchema },
          { name: FormDraft.name, schema: FormDraftSchema },
          { name: SsoState.name, schema: SsoStateSchema },
          { name: Job.name, schema: JobSchema },
          { name: SharedWorkflowRow.name, schema: SharedWorkflowSchema },
          { name: ExtensionRow.name, schema: ExtensionSchema },
          { name: FragmentRow.name, schema: FragmentSchema },
          { name: SharedList.name, schema: SharedListSchema },
          { name: EmailTemplateRow.name, schema: EmailTemplateSchema },
          { name: SignatureRequest.name, schema: SignatureRequestSchema },
          { name: DocumentBatch.name, schema: DocumentBatchSchema },
          { name: FormComment.name, schema: FormCommentSchema },
        ]),
        JwtModule.register({ secret: config.JWT_SECRET, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } }),
        ThrottlerModule.forRootAsync({
          imports: [rateLimitModule()],
          inject: [MongoThrottlerStorage],
          useFactory: (storage: MongoThrottlerStorage) => ({
            throttlers: [{ ttl: 60_000, limit: 300 }],
            storage,
            // Tests sign in many times from one IP; they opt back in with this header to test the limiter itself.
            skipIf: (ctx) => config.NODE_ENV === 'test' && !ctx.switchToHttp().getRequest().headers['x-test-throttle'],
          }),
        }),
        EventEmitterModule.forRoot(),
        // Finds @FormWorkflow methods anywhere in the app (none ship yet).
        DiscoveryModule,
      ],
      controllers: [
        HealthController,
        AuthController,
        SsoController,
        // Before OrgsController: /org/usage is a static route.
        PlansController,
        SiteController,
        OrgsController,
        AccessController,
        AuditController,
        FormsController,
        StylesController,
        WorkflowsController,
        ExtensionsController,
        ExtensionPipelineController,
        ExtensionRepoController,
        ExtensionBuildController,
        FragmentsController,
        ListsController,
        EmailTemplatesController,
        SignaturePublicController,
        PortalController,
        ApprovalLinkController,
        OrgMailController,
        CheckoutSettingsController,
        CheckoutPublicController,
        OrgLogController,
        OperatorController,
        SignaturesController,
        DocumentsController,
        PdfTemplatesController,
        SealController,
        FormReviewController,
        ExtensionPublicController,
        FormPublicController,
        SitePublicController,
        FormRecordController,
        NotificationsController,
        ConnectorSignInController,
        ConnectorsController,
        GatewaysController,
        ...(config.STORAGE_PROVIDER === 'local' ? [LocalStoreController] : []),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MAILER, useValue: mailerFor(config) },
        {
          provide: KEY_PROVIDER,
          useValue: config.KMS_KEY_ID ? new KmsKeyProvider(config.KMS_KEY_ID, config.AWS_REGION) : new LocalKeyProvider(Buffer.from(config.SECRET_KEY, 'base64')),
        },
        {
          provide: OBJECT_STORE,
          useValue:
            config.STORAGE_PROVIDER === 's3'
              ? new S3ObjectStore(config.UPLOADS_BUCKET, config.AWS_REGION)
              : new LocalObjectStore(config.LOCAL_STORAGE_DIR, config.API_URL, Buffer.from(config.SECRET_KEY, 'base64')),
        },
        { provide: FILE_SCANNER, useValue: config.FILE_SCANNER === 'clamav' ? new ClamAvScanner(config.CLAMAV_HOST, config.CLAMAV_PORT) : new NoFileScanner() },
        // Order matters: rate limit first, then authentication.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        AuditService,
        AuthService,
        OrgsService,
        PermissionService,
        AccessService,
        FormsService,
        StylesService,
        ConnectorsService,
        GatewaysService,
        PlansService,
        SiteService,
        DraftsService,
        SsoService,
        { provide: DNS_TXT, useValue: systemTxtResolver },
        // Work items (ported from Sangam form-platform).
        FormDefinitionService,
        PeopleService,
        MailService,
        NotificationsService,
        FormContextService,
        DataSourceQueryService,
        OpenWithService,
        CaptchaVerifierService,
        FormUploadService,
        FormSubmissionService,
        FormCalendarService,
        FormRecordService,
        JobQueue,
        WorkflowsService,
        ExtensionsService,
        FragmentsService,
        ListsService,
        EmailTemplatesService,
        SignaturesService,
        PortalService,
        OrgMailService,
        SmsService,
        VerifyService,
        PaymentsService,
        OrgLogService,
        OperatorService,
        ExtensionDeployService,
        ExtensionRepoService,
        { provide: GIT_REMOTE, useValue: new GitCli() },
        { provide: BUILD_RUNNER, useValue: config.EXT_BUILD_PROJECT ? new CodeBuildRunner(config.AWS_REGION, config.EXT_BUILD_PROJECT) : null },
        {
          provide: IMAGE_STORE,
          // Only where the installation is set up for it: otherwise the page says it is not switched on.
          useValue: config.EXT_REGISTRY && config.EXT_PUSH_ROLE_ARN ? new EcrImageStore(config.AWS_REGION, config.EXT_REGISTRY.slice(0, 12), config.EXT_PUSH_ROLE_ARN) : null,
        },
        DocumentsService,
        PdfTemplatesService,
        SealService,
        FormReviewService,
        FormAutomationService,
        FormHandlerRegistry,
        WorkItemService,
        FormWebhookService,
        WorkPortalService,
      ],
    };
  }
}
