terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # State belongs in a bucket of the account this is applied to. Configure at init:
  #   terraform init -backend-config="bucket=<state bucket>" -backend-config="key=form-builder/<env>.tfstate" -backend-config="region=ap-south-1"
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "form-builder"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
