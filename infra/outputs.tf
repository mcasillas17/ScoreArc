output "cloudsql_connection_name" { value = google_sql_database_instance.pg.connection_name }
output "artifact_registry_repo"   { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}" }
output "assets_bucket"            { value = google_storage_bucket.assets.name }
output "wif_provider"             { value = google_iam_workload_identity_pool_provider.github.name }
output "reader_sa_email"          { value = google_service_account.reader.email }
output "ingester_sa_email"        { value = google_service_account.ingester.email }
output "deployer_sa_email"        { value = google_service_account.deployer.email }
