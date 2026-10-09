variable "region" {
  description = "Where everything runs. Mumbai keeps customer data in India."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "stage or prod. Each has an AWS account of its own."
  type        = string
  validation {
    condition     = contains(["stage", "prod"], var.environment)
    error_message = "environment must be stage or prod."
  }
}

variable "api_domain" {
  description = "The API's public name, e.g. api.example.com."
  type        = string
}

variable "studio_domain" {
  description = "The builder's public name, e.g. app.example.com."
  type        = string
}

variable "forms_domain" {
  description = "The public form app's name, e.g. forms.example.com."
  type        = string
}

variable "certificate_arn" {
  description = "An ACM certificate in this region that covers api_domain."
  type        = string
}

variable "api_image" {
  description = "The API image to run (also the worker), e.g. <account>.dkr.ecr.ap-south-1.amazonaws.com/form-builder/api:<tag>."
  type        = string
}

variable "mongodb_url_secret_arn" {
  description = "Secrets Manager secret holding the MongoDB Atlas connection string. The database itself is not created here."
  type        = string
}

variable "mail_from" {
  description = "The sender of the product's email, on a domain verified in SES."
  type        = string
}

variable "default_plan" {
  description = "The plan of an organisation billing has not set."
  type        = string
  default     = "FREE"
}

variable "api_count" {
  description = "How many copies of the API run."
  type        = number
  default     = 2
}

variable "worker_count" {
  description = "How many workers take jobs from the queue."
  type        = number
  default     = 1
}

variable "extensions" {
  description = <<-EOT
    Customers' own code, one entry per extension: the image built from their repository, the
    organisation it belongs to, the Secrets Manager secret holding the signing secret issued
    when it was installed, and the addresses it may call out to (host:port, as in docs/hosting.md).
  EOT
  type = map(object({
    image      = string
    org_id     = string
    secret_arn = string
    allow      = optional(list(string), [])
  }))
  default = {}
}

variable "web_certificate_arn" {
  description = "An ACM certificate in us-east-1 (CloudFront reads certificates only from there) covering studio_domain and forms_domain."
  type        = string
}

variable "egress_image" {
  description = "The outbound proxy image (infra/docker/egress.Dockerfile), used for extensions that may call out."
  type        = string
  default     = ""
}
