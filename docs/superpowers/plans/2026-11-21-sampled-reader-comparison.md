# Sampled reader comparison implementation

- [x] Exercise the 10% boundary, parallel reads, mismatch, reference failure, deadline, cancellation and joined-source behavior. Run the focused Vitest file and expect the new cases to fail before implementation.
- [x] Wire the server-only compare mode into the existing DataStore selection and reuse the semantic comparator. Run the same tests and expect them to pass.
- [x] Record read and operation outcomes and provide a report by endpoint and error code. Test mismatch and failure denominators, and verify the report against preview traffic.
- [x] Run the full frontend suite, typecheck, lint and build. Verify the opt-in local preview and leave it available.

- [x] Verify frontend, reader and ingester HTTP coverage, include status/latency distributions in five-minute buckets, exercise the combined log report, and run the frontend and Go PR gates.
