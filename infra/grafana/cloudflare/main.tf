terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.29.0"
    }
  }
}

variable "account_id" { type = string }
variable "zone_id" { type = string }
variable "team_name" { type = string }
# Compose uses service DNS. The dedicated Fly Machine binds admin services to loopback.
variable "fly_origin" {
  type    = bool
  default = true
}
variable "operator_emails" {
  type = set(string)
  validation {
    condition = length(var.operator_emails) > 0 && alltrue([
      for email in var.operator_emails : can(regex("^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$", email))
    ])
    error_message = "Use one or more exact individual operator email addresses."
  }
}

locals {
  grafana = "grafana.scorearc.futbol"
  ingest  = "telemetry.scorearc.futbol"
}

resource "cloudflare_zero_trust_access_policy" "operators" {
  account_id = var.account_id
  name       = "ScoreArc operators"
  decision   = "allow"
  include    = [for email in sort(tolist(var.operator_emails)) : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_application" "grafana" {
  account_id       = var.account_id
  name             = "ScoreArc operations"
  type             = "self_hosted"
  domain           = local.grafana
  session_duration = "8h"
  policies = [{
    id         = cloudflare_zero_trust_access_policy.operators.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "operations" {
  account_id = var.account_id
  name       = "scorearc-observability"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "operations" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.operations.id
  config = {
    ingress = concat(
      [
        {
          hostname = local.grafana
          service  = var.fly_origin ? "http://127.0.0.1:3000" : "http://grafana:3000"
          origin_request = { access = {
            required  = true
            team_name = var.team_name
            aud_tag   = [cloudflare_zero_trust_access_application.grafana.aud]
          } }
        },
        { hostname = local.ingest, path = "^/vercel$", service = var.fly_origin ? "http://127.0.0.1:8080" : "http://receiver:8080" },
      ],
      # On Fly (fly_origin = true), the log shipper posts to loopback 127.0.0.1:8081/fly directly;
      # do not expose /fly on the public tunnel unless running a separate Compose origin.
      var.fly_origin ? [] : [{ hostname = local.ingest, path = "^/fly$", service = "http://receiver:8081" }],
      [{ service = "http_status:404" }]
    )
  }
}

resource "cloudflare_dns_record" "operations" {
  for_each   = toset([local.grafana, local.ingest])
  zone_id    = var.zone_id
  name       = each.key
  type       = "CNAME"
  content    = "${cloudflare_zero_trust_tunnel_cloudflared.operations.id}.cfargotunnel.com"
  proxied    = true
  ttl        = 1
  depends_on = [cloudflare_zero_trust_tunnel_cloudflared_config.operations]
}
