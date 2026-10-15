variable "db_password" {
  type      = string
  sensitive = true
  default   = "FIXTURE-SECRET-15"
}

resource "random_pet" "renamed" {
  length = 2
}

resource "random_password" "db" {
  length  = 20
  special = true
  keepers = { rotation = "1" }
}

resource "tls_private_key" "k" {
  algorithm = "ECDSA"
  ecdsa_curve = "P384"
}

resource "terraform_data" "cfg" {
  input = { version = "2", pw = var.db_password }
}


resource "random_string" "cbd" {
  length = 8
  keepers = { k = "2" }
  lifecycle { create_before_destroy = true }
}

resource "local_file" "drift" {
  filename = "${path.module}/out/drift.txt"
  content  = "hello"
}

resource "local_sensitive_file" "sf" {
  filename = "${path.module}/out/secret.txt"
  content  = random_password.db.result
}


module "naming" {
  source      = "./modules/naming"
  prefix      = "svc"
  secret_seed = var.db_password
  untyped     = "x"
}

module "label" {
  source    = "cloudposse/label/null"
  version   = "0.25.0"
  namespace = "eg"
  name      = "app"
}

output "pw" {
  value     = random_password.db.result
  sensitive = true
}

output "pet" {
  value = random_pet.renamed.id
}

output "label_id" {
  value = module.label.id
}

moved {
  from = random_pet.a
  to   = random_pet.renamed
}

import {
  to = random_id.imp
  id = "p-9hUg"
}

resource "random_id" "imp" {
  byte_length = 4
}

removed {
  from = random_id.keep
  lifecycle {
    destroy = false
  }
}

output "new_out" {
  value = "added"
}


resource "random_integer" "n" {
  count = 2
  min   = 1
  max   = 100
}

resource "random_password" "per_env" {
  for_each = toset(["dev", "prod"])
  length   = 10
}

data "local_sensitive_file" "read" {
  filename = local_sensitive_file.sf.filename
}

resource "terraform_data" "with_token" {
  input = {
    api_token   = "FIXTURE-plain-token-value"
    db_password = "FIXTURE-plain-password-value"
    note        = "not a secret"
  }
}
