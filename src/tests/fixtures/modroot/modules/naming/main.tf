resource "random_pet" "this" {
  prefix = var.prefix
  length = var.length
}

output "name" {
  value       = random_pet.this.id
  description = "Generated name."
}

output "seed" {
  value     = var.secret_seed
  sensitive = true
}
