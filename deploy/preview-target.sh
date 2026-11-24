set -eu

test "$(hostname -s)" = server-1
test -d /data1/weifeng/suqi
printf '%s\n' "$1" | grep -Eq '^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9_/-]+/w-suqi@sha256:[0-9a-f]{64}$'

docker pull --platform linux/amd64 "$1"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$1")" = linux/amd64
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1")" = "$2"
printf 'Target received %s for commit %s\n' "$1" "$2"
smoke "$1"
