resource "tls_private_key" "ca" {
  algorithm = "RSA"
}

resource "tls_self_signed_cert" "ca" {
  key_algorithm   = "RSA"
  private_key_pem = tls_private_key.ca.private_key_pem
  subject {
    common_name = "example"
  }
  validity_period_hours = 12
  allowed_uses          = ["cert_signing"]
}

resource "random_password" "p" {
  provider = rnd
  length   = 12
  number   = true
}

resource "random_id" "i" {
  provider    = rnd
  byte_length = 4
}

data "tls_public_key" "pk" {
  private_key_pem = tls_private_key.ca.private_key_pem
}

module "certs" {
  source = "./modules/certs"
  key    = tls_private_key.ca.private_key_pem
}

output "b64" {
  value = random_id.i.b64
}

output "tpl" {
  value = file("${path.module}/banner.txt")
}
