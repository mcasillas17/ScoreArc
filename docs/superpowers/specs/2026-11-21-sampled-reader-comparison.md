# Sampled reader comparison

In opt-in compare mode, sample 10% of logical non-news reads. The other 90% use ESPN alone. Draw once for a joined operation. On a sample, start the direct reader and ESPN reads together with separate budgets. Serve a reader operation only when the returned data agrees under the existing method-specific comparison. A difference, reader failure, timeout or inconclusive comparison selects the entire ESPN operation. When ESPN fails, preserve its error and record an inconclusive comparison. News stays on ESPN.

Report control volume, samples, matches, differences, reader and reference errors, actual source served and latency. Use bounded field paths, logical endpoint names and upstream HTTP status codes. ESPN is the comparison reference. A disagreement can also be a timing difference or a more complete reader result. Keep the shipped default on ESPN.
