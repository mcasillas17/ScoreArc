# Side-by-side match freshness on Cloudflare

The trial measures whether a five-minute Worker can make the same incident decisions as the GitHub watchdog at a suitable CPU and request cost. GitHub continues to own notifications, heartbeat and production checkpoints. Merge and deployment are separate operations.

Use the generated competition registry, the same bounded season reader and the same alert policy. A dedicated cron-only Worker reads the ScoreArc reader and writes to its own D1 database. Each completed tick records state for the next observation, per-edition open state and transitions, time and request counts. Commit a complete observation only against the previously read tick. Duplicate and late ticks cannot overwrite history. Keep a bounded recent comparison window and preserve the latest state through pauses.

The comparison uses the Actions pending artifact, which contains the observations' transitions before delivery. Pair by observation time and exact edition set. Record differences for investigation, including cold start, gaps, and changes in the reader between the two independent polls. Only a live match window with aligned histories can support a migration decision. The production state import, sender switch, external heartbeat and rollback handoff belong to a later slice.
