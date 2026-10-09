# Customers' own code (docs/extensions.md, docs/hosting.md): one locked-down service each,
# in subnets with no route out, reachable only by the API and the worker.
resource "aws_service_discovery_private_dns_namespace" "extensions" {
  name = "ext.${local.name}.internal"
  vpc  = aws_vpc.main.id
}

module "extension" {
  source   = "./modules/extension"
  for_each = var.extensions

  name               = each.key
  cluster_arn        = aws_ecs_cluster.main.arn
  vpc_id             = aws_vpc.main.id
  vpc_cidr           = aws_vpc.main.cidr_block
  isolated_subnets   = aws_subnet.isolated[*].id
  private_subnets    = aws_subnet.private[*].id
  namespace_id       = aws_service_discovery_private_dns_namespace.extensions.id
  namespace_name     = aws_service_discovery_private_dns_namespace.extensions.name
  app_security_group = aws_security_group.app.id
  endpoints_sg       = aws_security_group.endpoints.id
  execution_role_arn = aws_iam_role.execution.arn
  region             = var.region
  prefix             = local.name
  image              = each.value.image
  org_id             = each.value.org_id
  secret_arn         = each.value.secret_arn
  allow              = each.value.allow
  egress_image       = var.egress_image
}

output "extension_addresses" {
  description = "What to give `extension install` for each one."
  value       = { for k, m in module.extension : k => m.address }
}
