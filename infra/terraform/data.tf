# Files people upload and the PDFs we make. Private, encrypted, never public.
resource "aws_s3_bucket" "uploads" {
  bucket_prefix = "${local.name}-uploads-"
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Browsers send files straight to the bucket with a short-lived link.
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = ["https://${var.studio_domain}", "https://${var.forms_domain}"]
    allowed_headers = ["content-type"]
    max_age_seconds = 300
  }
}

# Wraps the keys that seal connector credentials and extension secrets. The key never leaves KMS.
resource "aws_kms_key" "secrets" {
  description             = "${local.name}: connector credentials and extension secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# Signs sessions. Made here, readable only by the API and worker tasks.
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name_prefix = "${local.name}/jwt-"
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/${local.name}/api"
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/${local.name}/worker"
  retention_in_days = 90
}
