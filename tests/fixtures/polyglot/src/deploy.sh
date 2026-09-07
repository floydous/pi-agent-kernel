#!/usr/bin/env bash
# Realistic deployment script with multiple functions, env handling, and error reporting.

set -euo pipefail

readonly DEFAULT_REGION="${DEPLOY_REGION:-us-east-1}"
readonly MAX_RETRIES=3

log() {
    local level="$1"
    shift
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$level] $*" >&2
}

deploy_cluster() {
    local env_name="$1"
    local region="${2:-$DEFAULT_REGION}"
    local attempt=0

    if [[ -z "$env_name" ]]; then
        log "ERROR" "environment name required"
        return 1
    fi

    log "INFO" "Deploying to $env_name in $region"
    while (( attempt < MAX_RETRIES )); do
        (( attempt++ )) || true
        if kubectl apply -f "manifests/${env_name}.yaml" --context "$region"; then
            log "INFO" "Deployment succeeded on attempt $attempt"
            return 0
        fi
        log "WARN" "Deployment failed on attempt $attempt, retrying"
        sleep $(( attempt * 5 ))
    done
    log "ERROR" "Deployment failed after $MAX_RETRIES attempts"
    return 1
}

rollback_cluster() {
    local env_name="$1"
    log "INFO" "Rolling back $env_name"
    kubectl rollout undo deployment/"$env_name"
}

health_check() {
    local service="$1"
    if ! curl -fsS "https://${service}/healthz" > /dev/null; then
        log "ERROR" "Health check failed for $service"
        return 1
    fi
    return 0
}
