resource "google_service_account" "reader" {
  account_id   = "scorearc-reader"
  display_name = "ScoreArc Reader (Cloud Run)"
}
resource "google_service_account" "ingester" {
  account_id   = "scorearc-ingester"
  display_name = "ScoreArc Ingester (Cloud Run)"
}

# Each service can connect to Cloud SQL and read ONLY its own DSN secret.
resource "google_project_iam_member" "reader_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.reader.email}"
}
resource "google_project_iam_member" "ingester_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.ingester.email}"
}
resource "google_secret_manager_secret_iam_member" "reader_secret" {
  secret_id = google_secret_manager_secret.reader_dsn.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.reader.email}"
}
resource "google_secret_manager_secret_iam_member" "ingester_secret" {
  secret_id = google_secret_manager_secret.ingester_dsn.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.ingester.email}"
}
# Only the ingester writes logo objects.
resource "google_storage_bucket_iam_member" "ingester_assets_write" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ingester.email}"
}
