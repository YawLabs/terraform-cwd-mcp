terraform {
  required_providers {
    tls = { source = "hashicorp/tls", version = ">= 3.0" }
  }
}
variable "key" {
  type      = string
  sensitive = true
}
resource "tls_cert_request" "r" {
  key_algorithm   = "RSA"
  private_key_pem = var.key
  subject {
    common_name = "x"
  }
}
