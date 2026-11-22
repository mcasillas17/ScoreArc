# Grafana operations dashboard plan

- [x] Provision one Grafana dashboard with Loki and read-only PostgreSQL data sources. Exercise its queries against actual Grafana, Loki and PostgreSQL with controlled events and poll records.
- [x] Verify the receiver handles Vercel drain batches and Fly log envelopes, rejects unauthenticated traffic and discards unrelated data.
- [ ] Configure the private origin and Cloudflare application for the approved operator. Check the anonymous challenge and private-origin isolation before publishing a public URL.
- [ ] Verify live data where provider access is available and document activation, retention, and recovery.
