resource "google_storage_bucket" "assets" {
  name                        = "${var.project_id}-scorearc-assets"
  location                    = var.region
  uniform_bucket_level_access = true
  depends_on                  = [google_project_service.apis]
}

# Public-read objects (logos are public content served via CDN).
resource "google_storage_bucket_iam_member" "assets_public_read" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}
