# Split the ScoreArc operations dashboard

Keep the existing Grafana home URL as an overview of all four investigations. Six statistics cover observed sampling rate, disagreement, ESPN fallbacks, HTTP failure rate, failed ingester runs and newly discovered ESPN changes. Reader comparisons shows sample size and the disagreement denominator. Use Grafana's native dashboard links to take the selected time range into any of four investigations.

| Dashboard | Investigation |
| --- | --- |
| Reader comparisons | Which logical reads agree, fail, or fall back? What did the reader know about resource age and availability? |
| HTTP health | Which physical requests fail or slow down across the frontend, reader, ingester and ESPN? |
| Ingester health | Which match polls, jobs or recovery attempts need attention? |
| ESPN data quality | Which provider fields changed? Which recorded responses have replay coverage? |

The operator chose separate dashboards over collapsing rows on the same page. Give each detailed panel one home, keep its query and identity, and retain read-only provisioning in the Operations folder. Dashboard-level bookmarks keep their original UID. Runbook links to moved investigations should open the relevant view. The collection, Access policy and sampling configuration have separate lifecycles.
