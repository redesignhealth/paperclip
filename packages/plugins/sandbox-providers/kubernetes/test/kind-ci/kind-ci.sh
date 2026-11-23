#!/usr/bin/env bash
# kind cluster setup for the Kubernetes sandbox CI test (TECH-9831).
#
# Installs the sandbox prerequisites the way the rh-paperclip operator scripts do, as the cluster
# admin, then mints a kubeconfig for a NON-admin identity: the group "paperclip-server", which is
# what the EKS access entry maps the server's IAM role to. The test runs only as that identity.
#
# Usage: kind-ci.sh cluster | prereqs | image | kubeconfig
set -euo pipefail

CLUSTER="${KIND_CI_CLUSTER:-paperclip-ci}"
NODE_IMAGE="${KIND_CI_NODE_IMAGE:-kindest/node:v1.32.2}"
# Same agent-sandbox release and checksum as rh-paperclip scripts/prod-eks/install-addons.sh.
SANDBOX_VERSION="v0.5.6"
SANDBOX_SHA256="f1127ab655a07de5f65991339fc8cd5200f471652f61d7ceeaa8e7c6cc252581"
SANDBOX_CONTROLLER_IMAGE="registry.k8s.io/agent-sandbox/agent-sandbox-controller:${SANDBOX_VERSION}"
# The plugin's default runtime image for pi_local; the stub image is tagged as it so no override is needed.
RUNTIME_IMAGE="ghcr.io/paperclipai/agent-runtime-pi:v1"
COMPANY_SLUG="ci"
COMPANY_ID="33333333-3333-4333-8333-333333333333"
NAMESPACE="paperclip-${COMPANY_SLUG}"
OUT_DIR="${KIND_CI_OUT:-/tmp/kind-ci}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_CTX="kind-${CLUSTER}"

admin() { kubectl --context "$ADMIN_CTX" "$@"; }

# `kind load` fails ("content digest not found") on some runners where Docker uses the containerd image
# store and the image is a multi-platform index. Fall back to importing only this platform's content.
load_image() {
  local img="$1"
  kind load docker-image "$img" --name "$CLUSTER" && return 0
  echo "kind load failed for $img; importing the single-platform archive" >&2
  docker save --platform linux/amd64 "$img" | docker exec --privileged -i "${CLUSTER}-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs -
}

cluster() {
  if ! kind get clusters | grep -qx "$CLUSTER"; then
    kind create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 180s
  fi
  admin get nodes
}

prereqs() {
  mkdir -p "$OUT_DIR"
  # agent-sandbox controller, pinned and verified like prod-eks/install-addons.sh.
  curl -fsSL -o "$OUT_DIR/sandbox.yaml" "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${SANDBOX_VERSION}/sandbox.yaml"
  actual="$( (sha256sum "$OUT_DIR/sandbox.yaml" 2>/dev/null || shasum -a 256 "$OUT_DIR/sandbox.yaml") | cut -d' ' -f1)"
  [ "$actual" = "$SANDBOX_SHA256" ] || { echo "sandbox.yaml sha256 mismatch" >&2; exit 1; }
  if docker image inspect "$SANDBOX_CONTROLLER_IMAGE" >/dev/null 2>&1; then
    load_image "$SANDBOX_CONTROLLER_IMAGE"
  fi
  admin apply --server-side -f "$OUT_DIR/sandbox.yaml"
  admin -n agent-sandbox-system rollout status deploy --timeout=180s
  admin wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=60s

  # RBAC: the dev file as is (pc-control, the namespace-read ClusterRole, the proof namespace), then
  # the prod per-company file with the placeholders replaced the way company-namespace.sh does.
  admin apply -f "$here/rbac/paperclip-rbac.yaml"
  sed -e "s/__NAMESPACE__/${NAMESPACE}/g" -e "s/__COMPANY_ID__/${COMPANY_ID}/g" "$here/rbac/company-rbac.yaml" | admin apply -f -
  admin get ns "$NAMESPACE" --show-labels
}

image() {
  docker build -t "$RUNTIME_IMAGE" "$here/runtime"
  load_image "$RUNTIME_IMAGE"
}

kubeconfig() {
  mkdir -p "$OUT_DIR"
  local d; d="$(mktemp -d)"
  docker cp "${CLUSTER}-control-plane:/etc/kubernetes/pki/ca.crt" "$d/ca.crt"
  docker cp "${CLUSTER}-control-plane:/etc/kubernetes/pki/ca.key" "$d/ca.key"
  openssl genrsa -out "$d/client.key" 2048 2>/dev/null
  openssl req -new -key "$d/client.key" -subj "/CN=paperclip-ci-server/O=paperclip-server" -out "$d/client.csr"
  openssl x509 -req -in "$d/client.csr" -CA "$d/ca.crt" -CAkey "$d/ca.key" -CAcreateserial -days 1 -out "$d/client.crt" 2>/dev/null
  local server; server="$(admin config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
  local kc="$OUT_DIR/server.kubeconfig"; rm -f "$kc"
  kubectl config set-cluster "$CLUSTER" --kubeconfig "$kc" --server "$server" --certificate-authority "$d/ca.crt" --embed-certs=true >/dev/null
  kubectl config set-credentials paperclip-server --kubeconfig "$kc" --client-certificate "$d/client.crt" --client-key "$d/client.key" --embed-certs=true >/dev/null
  kubectl config set-context ci --kubeconfig "$kc" --cluster "$CLUSTER" --user paperclip-server >/dev/null
  kubectl config use-context ci --kubeconfig "$kc" >/dev/null
  rm -rf "$d"
  # Guard: this identity must not be an admin, or the test proves nothing about permissions.
  if [ "$(kubectl --kubeconfig "$kc" auth can-i '*' '*' 2>/dev/null || true)" = "yes" ]; then
    echo "server identity is cluster-admin; refusing" >&2; exit 1
  fi
  if [ "$(kubectl --kubeconfig "$kc" auth can-i create namespaces 2>/dev/null || true)" = "yes" ]; then
    echo "server identity can create namespaces; prod's cannot" >&2; exit 1
  fi
  echo "kubeconfig for group paperclip-server written to $kc"
}

"${1:?usage: kind-ci.sh cluster|prereqs|image|kubeconfig}"
