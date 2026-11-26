# Move the match freshness watchdog to Cloudflare

Run the five-minute monitor in ScoreArc's existing alert receiver. Its cron, email binding, D1 event receipts and missed-heartbeat alarm are already in production. The GitHub and Worker producers share the reader, alert policy, validated checkpoint format and delivery queue. A Worker event links to receiver logs and carries the observation time, incident ID and event ID.

One D1 row controls ownership. The initial mode keeps dispatching GitHub. Draining stops new dispatches while allowing the last GitHub run to finish. Once the workflow is disabled and its runs have drained, an operator imports the newest trusted, fully acknowledged final artifact and atomically selects Cloudflare. Carry forward the epoch, sequence, receipts, policy signals and open incidents.

Each native tick claims a lease, persists its reservations before sending through the receiver, and persists the final checkpoint before advancing the heartbeat. The receiver keeps checking the heartbeat in every mode. Reject legacy HTTP sends and heartbeats once Cloudflare owns the monitor. Keep the shadow database for trial evidence and pause its cron after verifying native operation.
