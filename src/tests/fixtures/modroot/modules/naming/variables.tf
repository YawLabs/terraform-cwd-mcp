variable "prefix" {
  type        = string
  description = "Name prefix."
  validation {
    condition     = length(var.prefix) > 0
    error_message = "prefix must not be empty."
  }
  validation {
    condition     = can(regex("^[a-z]", var.prefix))
    error_message = "prefix must start with a letter."
  }
}

variable "tags" {
  type = map(object({
    value    = string
    optional = optional(bool, false)
  }))
  default  = {}
  nullable = false
}

variable "secret_seed" {
  type      = string
  sensitive = true
  default   = null
}

variable "length" {
  description = <<-EOT
    Pet name length.
    Multi-line heredoc description.
  EOT
  type    = number
  default = 2
}

variable "untyped" {}
