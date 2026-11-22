FROM timberio/vector:0.62.0-alpine AS vector
FROM grafana/loki:3.7.10 AS loki
FROM cloudflare/cloudflared:2026.11.1 AS tunnel
FROM grafana/grafana:13.3.1
USER root
RUN apk add --no-cache bash su-exec
COPY --from=vector /usr/local/bin/vector /usr/local/bin/vector
COPY --from=loki /usr/bin/loki /usr/local/bin/loki
COPY --from=tunnel /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY dashboards /etc/scorearc/dashboards
COPY provisioning /etc/grafana/provisioning
COPY loki.yaml vector.yaml fly/shipper.yaml /etc/scorearc/
# The Fly services share loopback and one persistent volume. Compose uses service DNS.
RUN sed -i -e 's|/loki|/data/loki|g' -e '/http_listen_port:/a\  http_listen_address: 127.0.0.1\n  grpc_listen_address: 127.0.0.1' /etc/scorearc/loki.yaml \
 && sed -i -e 's|/var/lib/vector|/data/vector|' -e 's|0.0.0.0:8081|127.0.0.1:8081|' -e 's|http://loki:3100|http://127.0.0.1:3100|' /etc/scorearc/vector.yaml /etc/grafana/provisioning/datasources/scorearc.yaml \
 && sed -i -e 's|/etc/vector/shipper-credentials.json|/etc/vector-shipper.json|' -e 's|https://telemetry.scorearc.futbol/fly|http://127.0.0.1:8081/fly|' /etc/scorearc/shipper.yaml \
 && sed -i 's|/var/lib/grafana/dashboards|/etc/scorearc/dashboards|' /etc/grafana/provisioning/dashboards/scorearc.yml
ENV GF_SERVER_HTTP_ADDR=127.0.0.1 GF_SERVER_ROOT_URL=https://grafana.scorearc.futbol \
    GF_PATHS_DATA=/data/grafana GF_PATHS_PLUGINS=/data/grafana/plugins \
    GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/etc/scorearc/dashboards/scorearc-operations.json \
    GF_AUTH_ANONYMOUS_ENABLED=false GF_USERS_ALLOW_SIGN_UP=false GF_USERS_VIEWERS_CAN_EDIT=false \
    GF_ANALYTICS_REPORTING_ENABLED=false GF_SECURITY_COOKIE_SECURE=true PGSSLMODE=verify-full
COPY fly-entrypoint.sh /usr/local/bin/start-operations
ENTRYPOINT ["/usr/local/bin/start-operations"]
