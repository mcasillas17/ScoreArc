resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "scorearc"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}
