# The builder and the public form app: static files in private buckets, served by CloudFront.
locals {
  sites = {
    studio = var.studio_domain
    forms  = var.forms_domain
  }
}

resource "aws_s3_bucket" "site" {
  for_each      = local.sites
  bucket_prefix = "${local.name}-${each.key}-"
}

resource "aws_s3_bucket_public_access_block" "site" {
  for_each                = local.sites
  bucket                  = aws_s3_bucket.site[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.name}-sites"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  for_each            = local.sites
  enabled             = true
  default_root_object = "index.html"
  aliases             = [each.value]
  http_version        = "http2and3"
  price_class         = "PriceClass_200"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site[each.key].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # AWS managed policy "CachingOptimized": built files carry a hash in their name.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Every address that is not a file is a page of the app.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.web_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "site" {
  for_each = local.sites
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site[each.key].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site[each.key].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  for_each = local.sites
  bucket   = aws_s3_bucket.site[each.key].id
  policy   = data.aws_iam_policy_document.site[each.key].json
}

output "site_buckets" {
  description = "Upload each app's built files (apps/<app>/dist) to its bucket."
  value       = { for k, b in aws_s3_bucket.site : k => b.bucket }
}

output "site_distributions" {
  description = "Point studio_domain and forms_domain at these names."
  value       = { for k, d in aws_cloudfront_distribution.site : k => d.domain_name }
}
