# Private services access so Cloud SQL gets a private IP only.
resource "google_compute_network" "vpc" {
  name                    = "scorearc-vpc"
  auto_create_subnetworks = true
  depends_on              = [google_project_service.apis]
}

resource "google_compute_global_address" "private_ip" {
  name          = "scorearc-sql-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private_vpc" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

resource "google_sql_database_instance" "pg" {
  name             = "scorearc-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  depends_on       = [google_service_networking_connection.private_vpc]

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    ip_configuration {
      ipv4_enabled    = false                       # NO public IP
      private_network = google_compute_network.vpc.id
    }
    backup_configuration { enabled = true }
  }
  deletion_protection = true
}

resource "google_sql_database" "app" {
  name     = "scorearc"
  instance = google_sql_database_instance.pg.name
}

# Login users mapped to the least-privilege roles created by the migrations.
resource "random_password" "reader"   { length = 24, special = false }
resource "random_password" "ingester" { length = 24, special = false }

resource "google_sql_user" "reader" {
  name     = "scorearc_reader_user"
  instance = google_sql_database_instance.pg.name
  password = random_password.reader.result
}
resource "google_sql_user" "ingester" {
  name     = "scorearc_ingester_user"
  instance = google_sql_database_instance.pg.name
  password = random_password.ingester.result
}

# Store the connection strings in Secret Manager (Cloud Run reads them).
resource "google_secret_manager_secret" "reader_dsn" {
  secret_id = "scorearc-reader-dsn"
  replication { auto {} }
}
resource "google_secret_manager_secret_version" "reader_dsn" {
  secret      = google_secret_manager_secret.reader_dsn.id
  secret_data = "postgres://${google_sql_user.reader.name}:${random_password.reader.result}@/scorearc?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
}
resource "google_secret_manager_secret" "ingester_dsn" {
  secret_id = "scorearc-ingester-dsn"
  replication { auto {} }
}
resource "google_secret_manager_secret_version" "ingester_dsn" {
  secret      = google_secret_manager_secret.ingester_dsn.id
  secret_data = "postgres://${google_sql_user.ingester.name}:${random_password.ingester.result}@/scorearc?host=/cloudsql/${google_sql_database_instance.pg.connection_name}"
}
