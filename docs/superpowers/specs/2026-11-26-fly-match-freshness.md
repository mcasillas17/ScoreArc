# Match freshness on the existing Fly monitoring machine

Run the five-minute timer, season reader and alert policy on the existing private scorearc-observability machine. Give the process its own unprivileged UID, environment and restart loop. It reads the public ScoreArc reader. Grafana, Loki and log shipping continue running if the watchdog restarts.

The Cloudflare receiver owns the D1 checkpoint, email receipts and the independent missed-heartbeat cron. A dedicated bearer token grants Fly access to the six monitor operations. The receiver checks slot ownership and phase. It commits pending events before sending, checks the event receipts before accepting a final checkpoint, and advances the heartbeat only after that checkpoint. D1 provides one active writer across restarts and deployments.

Start in GitHub mode. Stage Fly, check that it reaches the receiver, drain GitHub, then import the newest trusted final artifact into D1. Keep the epoch, sequence, open incidents, policy signals and receipts. A rollback parks a settled D1 checkpoint and gives the manual GitHub workflow its history back. The separate shadow Worker stays paused.
