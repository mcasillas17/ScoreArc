variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "us-central1"
}

variable "db_tier" {
  type    = string
  default = "db-f1-micro"
}
variable "github_repo" {
  type        = string
  description = "owner/name of the GitHub repo allowed to deploy via WIF, e.g. mcasillas17/ScoreArc"
}
variable "assets_domain" {
  type        = string
  description = "CDN domain for self-hosted logos, e.g. cdn.scorearc.futbol"
}
