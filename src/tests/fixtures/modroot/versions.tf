terraform {
  required_version = ">= 1.7"
  required_providers {
    random = { source = "hashicorp/random", version = "3.6.3" }
    tls    = { source = "hashicorp/tls", version = "4.0.6" }
    null   = { source = "hashicorp/null", version = "3.2.3" }
    local  = { source = "hashicorp/local", version = "2.5.2" }
  }
}
