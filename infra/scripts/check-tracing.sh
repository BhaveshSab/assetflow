#!/usr/bin/env bash
# Isolated CI smoke: validate the actual Jaeger config, ingest and query a trace.
set -euo pipefail
cd "$(dirname "$0")/../.."
name="assetflow-tracing-check"
cleanup() {
    local code=$?
    if [ "$code" -ne 0 ]; then
        echo '::error title=tracing::Jaeger startup/OTLP ingestion/query smoke failed'
        docker logs "$name" || true
    fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    exit "$code"
}
trap cleanup EXIT
docker run -d --name "$name" \
    -p 127.0.0.1:14318:4318 -p 127.0.0.1:16687:16686 \
    -v "$PWD/infra/jaeger/config.yml:/etc/jaeger/config.yml:ro" \
    jaegertracing/jaeger:2.11.0 --config=/etc/jaeger/config.yml
ready=false
for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:16687/api/services >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
done
[ "$ready" = true ] || exit 1
trace_id=12121212121212121212121212121212
now=$(date +%s%N)
curl -fsS -H 'Content-Type: application/json' http://127.0.0.1:14318/v1/traces \
    --data "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"assetflow-ci\"}}]},\"scopeSpans\":[{\"scope\":{\"name\":\"smoke\"},\"spans\":[{\"traceId\":\"$trace_id\",\"spanId\":\"3434343434343434\",\"name\":\"tracing.smoke\",\"kind\":1,\"startTimeUnixNano\":\"$now\",\"endTimeUnixNano\":\"$now\"}]}]}]}"
for attempt in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:16687/api/traces/$trace_id" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert any(s["operationName"] == "tracing.smoke" for t in d.get("data",[]) for s in t["spans"])' 2>/dev/null; then
        echo 'Jaeger OTLP ingestion and query passed'
        exit 0
    fi
    sleep 1
done
exit 1
