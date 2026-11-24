#!/bin/sh
set -eu

smoke() (
    container=$(docker run --detach --rm --network none "$1")
    trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
    docker exec "$container" node --input-type=module -e '
        const deadline = Date.now() + 10000;
        while (true) {
            try {
                const response = await fetch("http://127.0.0.1:5001/", { signal: AbortSignal.timeout(1000) });
                if (response.ok && (await response.text()).includes("开放词汇目标检测")) break;
            } catch {}
            if (Date.now() >= deadline) throw new Error("The container did not serve its homepage on port 5001");
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        console.log("Homepage on container port 5001 verified");
    '
)

if [ "${0##*/}" = smoke.sh ]; then
    smoke "$1"
fi
