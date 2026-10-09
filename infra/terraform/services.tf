# The API and the worker: the same image, on Fargate, in private subnets.
resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "random_bytes" "secret_key" {
  length = 32
}

resource "aws_secretsmanager_secret" "secret_key" {
  name_prefix = "${local.name}/secret-key-"
}

resource "aws_secretsmanager_secret_version" "secret_key" {
  secret_id     = aws_secretsmanager_secret.secret_key.id
  secret_string = random_bytes.secret_key.base64
}

data "aws_iam_policy_document" "tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# What ECS itself needs to start a task: pull the image, write logs, read the secrets it is given.
resource "aws_iam_role" "execution" {
  name_prefix        = "${local.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([aws_secretsmanager_secret.jwt.arn, aws_secretsmanager_secret.secret_key.arn, var.mongodb_url_secret_arn], [for e in var.extensions : e.secret_arn])
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# What our own code may do: its bucket, its key, sending mail. No access keys anywhere.
resource "aws_iam_role" "app" {
  name_prefix        = "${local.name}-app-"
  assume_role_policy = data.aws_iam_policy_document.tasks_assume.json
}

data "aws_iam_policy_document" "app" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/*"]
  }
  statement {
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.secrets.arn]
  }
  statement {
    actions   = ["ses:SendEmail"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.mail_from]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  vpc_id      = aws_vpc.main.id
  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "To the API"
    from_port   = 4100
    to_port     = 4100
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

resource "aws_security_group" "app" {
  name_prefix = "${local.name}-app-"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "The load balancer"
    from_port       = 4100
    to_port         = 4100
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "The database, AWS, the systems of customers (through the NAT gateway) and extensions"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "api" {
  name               = "${local.name}-api"
  load_balancer_type = "application"
  subnets            = aws_subnet.public[*].id
  security_groups    = [aws_security_group.alb.id]
  # A dropped connection must not look like the request never arrived.
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name_prefix = "fbapi-"
  port        = 4100
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
  }
  deregistration_delay = 30
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

locals {
  app_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "4100" },
    { name = "APP_URL", value = "https://${var.studio_domain}" },
    { name = "API_URL", value = "https://${var.api_domain}" },
    { name = "FORM_APP_URL", value = "https://${var.forms_domain}" },
    { name = "CORS_ORIGINS", value = "https://${var.studio_domain},https://${var.forms_domain}" },
    { name = "COOKIE_SECURE", value = "true" },
    { name = "MAIL_PROVIDER", value = "ses" },
    { name = "MAIL_FROM", value = var.mail_from },
    { name = "AWS_REGION", value = var.region },
    { name = "STORAGE_PROVIDER", value = "s3" },
    { name = "UPLOADS_BUCKET", value = aws_s3_bucket.uploads.bucket },
    { name = "KMS_KEY_ID", value = aws_kms_key.secrets.arn },
    { name = "DEFAULT_PLAN", value = var.default_plan },
  ]
  app_secrets = [
    { name = "MONGODB_URL", valueFrom = var.mongodb_url_secret_arn },
    { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt.arn },
    { name = "SECRET_KEY", valueFrom = aws_secretsmanager_secret.secret_key.arn },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.api_image
    essential    = true
    user         = "1000"
    portMappings = [{ containerPort = 4100, protocol = "tcp" }]
    # The API only stores jobs; the worker runs them.
    environment = concat(local.app_environment, [{ name = "JOBS_ROLE", value = "enqueue" }])
    secrets     = local.app_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.api.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "api" }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  container_definitions = jsonencode([{
    name        = "worker"
    image       = var.api_image
    essential   = true
    user        = "1000"
    command     = ["node", "dist/worker.js"]
    environment = local.app_environment
    secrets     = local.app_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = aws_cloudwatch_log_group.worker.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "worker" }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4100
  }
  # A release that does not come up is taken back by itself.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

output "api_load_balancer" {
  description = "Point api_domain at this name."
  value       = aws_lb.api.dns_name
}
