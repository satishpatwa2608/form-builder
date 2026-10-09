# Copy to <environment>.tfvars and fill in. Nothing here is a secret; secrets are named by ARN.
environment            = "stage"
api_domain             = "api.stage.example.com"
studio_domain          = "app.stage.example.com"
forms_domain           = "forms.stage.example.com"
certificate_arn        = "arn:aws:acm:ap-south-1:000000000000:certificate/replace-me"
web_certificate_arn    = "arn:aws:acm:us-east-1:000000000000:certificate/replace-me"
api_image              = "000000000000.dkr.ecr.ap-south-1.amazonaws.com/form-builder/api:replace-me"
mongodb_url_secret_arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:form-builder/mongodb-replace-me"
mail_from              = "Form Builder <no-reply@example.com>"

# One entry per customer extension.
extensions = {
  # acme = {
  #   image      = "000000000000.dkr.ecr.ap-south-1.amazonaws.com/form-builder/ext-acme:replace-me"
  #   org_id     = "00000000-0000-0000-0000-000000000000"
  #   secret_arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:form-builder/ext-acme-replace-me"
  #   allow      = ["erp.acme.com", "api.acme.com:8443"]
  # }
}
