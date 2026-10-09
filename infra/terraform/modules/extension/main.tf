# One customer's extension: their image, run with nothing it does not need.
# The same rules as infra/stack.mjs applies on Docker: not root, read-only disk, no extra
# rights, small limits, no way in except from our API and worker, and no way out unless a
# list of addresses has been agreed, in which case only through a proxy of ours.

variable "name" { type = string }
variable "prefix" { type = string }
variable "region" { type = string }
variable "cluster_arn" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "isolated_subnets" { type = list(string) }
variable "private_subnets" { type = list(string) }
variable "namespace_id" { type = string }
variable "namespace_name" { type = string }
variable "app_security_group" { type = string }
variable "endpoints_sg" { type = string }
variable "execution_role_arn" { type = string }
variable "image" { type = string }
variable "org_id" { type = string }
variable "secret_arn" { type = string }
variable "allow" { type = list(string) }
variable "egress_image" { type = string }

locals {
  full      = "${var.prefix}-ext-${var.name}"
  has_proxy = length(var.allow) > 0
  proxy_url = "http://${var.name}-egress.${var.namespace_name}:3128"
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/${var.prefix}/extensions/${var.name}"
  retention_in_days = 30
}

resource "aws_security_group" "extension" {
  name_prefix = "${local.full}-"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Our API and worker, and nothing else"
    from_port       = 8080
    to_port         = 8080
    protocol        = "tcp"
    security_groups = [var.app_security_group]
  }
  egress {
    description     = "AWS itself, to fetch the image and write logs"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [var.endpoints_sg]
  }
}

resource "aws_security_group" "proxy" {
  count       = local.has_proxy ? 1 : 0
  name_prefix = "${local.full}-egress-"
  vpc_id      = var.vpc_id
  ingress {
    description     = "Only the extension of this customer"
    from_port       = 3128
    to_port         = 3128
    protocol        = "tcp"
    security_groups = [aws_security_group.extension.id]
  }
  egress {
    description = "Out, to what the list of the proxy allows"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group_rule" "to_proxy" {
  count                    = local.has_proxy ? 1 : 0
  type                     = "egress"
  description              = "Its own proxy"
  from_port                = 3128
  to_port                  = 3128
  protocol                 = "tcp"
  security_group_id        = aws_security_group.extension.id
  source_security_group_id = aws_security_group.proxy[0].id
}

resource "aws_service_discovery_service" "extension" {
  name = var.name
  dns_config {
    namespace_id = var.namespace_id
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_service_discovery_service" "proxy" {
  count = local.has_proxy ? 1 : 0
  name  = "${var.name}-egress"
  dns_config {
    namespace_id = var.namespace_id
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_task_definition" "extension" {
  family                   = local.full
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.execution_role_arn
  # No task role: the customer's code is given no AWS permissions at all.
  container_definitions = jsonencode([{
    name                   = "extension"
    image                  = var.image
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    linuxParameters        = { capabilities = { drop = ["ALL"] } }
    portMappings           = [{ containerPort = 8080, protocol = "tcp" }]
    environment = concat(
      [{ name = "PORT", value = "8080" }, { name = "FB_ORG_ID", value = var.org_id }],
      local.has_proxy ? [
        { name = "HTTP_PROXY", value = local.proxy_url },
        { name = "HTTPS_PROXY", value = local.proxy_url },
        { name = "NO_PROXY", value = "127.0.0.1,localhost" },
        { name = "NODE_USE_ENV_PROXY", value = "1" },
      ] : [],
    )
    secrets = [{ name = "FB_EXTENSION_SECRET", valueFrom = var.secret_arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.this.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "extension" }
    }
  }])
}

resource "aws_ecs_service" "extension" {
  name            = local.full
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.extension.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.isolated_subnets
    security_groups = [aws_security_group.extension.id]
  }
  service_registries {
    registry_arn = aws_service_discovery_service.extension.arn
  }
  # A version that does not start is replaced by the one that was running.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_ecs_task_definition" "proxy" {
  count                    = local.has_proxy ? 1 : 0
  family                   = "${local.full}-egress"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.execution_role_arn
  container_definitions = jsonencode([{
    name                   = "egress"
    image                  = var.egress_image
    essential              = true
    user                   = "1000"
    readonlyRootFilesystem = true
    linuxParameters        = { capabilities = { drop = ["ALL"] } }
    portMappings           = [{ containerPort = 3128, protocol = "tcp" }]
    environment = [
      { name = "ALLOW", value = join(",", var.allow) },
      # Never a way into our own network, whatever the list says.
      { name = "NEVER", value = var.vpc_cidr },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.this.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "egress" }
    }
  }])
}

resource "aws_ecs_service" "proxy" {
  count           = local.has_proxy ? 1 : 0
  name            = "${local.full}-egress"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.proxy[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.private_subnets
    security_groups = [aws_security_group.proxy[0].id]
  }
  service_registries {
    registry_arn = aws_service_discovery_service.proxy[0].arn
  }
}

output "address" {
  value = "http://${var.name}.${var.namespace_name}:8080"
}
