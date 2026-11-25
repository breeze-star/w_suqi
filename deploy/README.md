# w-suqi 测试环境预演

目标为通过已授权访问路径连接的测试机 `server-1`。服务器上的项目目录为 `/data1/weifeng/suqi`。`w-suqi` 通过 `network_mode: host` 使用宿主机现有网络，直接在 `SUQI_BIND_IP:5001` 监听。项目目录只读挂载到 `/data/suqi`，程序从镜像内 `/app` 启动。

## 配置 Jenkins

创建项目级 Pipeline from SCM，仓库与发布分支使用业务方指定的 GitHub 路径，脚本路径为 `Jenkinsfile`。使用具备 Docker 构建能力的受控 Agent，并为其分配 `w-suqi-builder` 作业标签。在受控作业或 Agent 环境中配置以下参数。

| 变量或配置 | 用途 |
| --- | --- |
| SCM 凭据 | 读取该项目 GitHub 仓库，由 Pipeline from SCM 配置 |
| `SUQI_ACR_REPOSITORY` | 已核实可见性的 ACR 项目路径，形式如 `registry.example.com/namespace/w-suqi` |
| `SUQI_ACR_PUSH_CREDENTIALS_ID` | 有权向该项目 ACR 仓库推送的 Jenkins 用户名密码凭据 ID |
| `SUQI_TARGET_SSH_HOST` | Jenkins Agent 上预先配置的测试机非交互 SSH 别名，使用公司批准的访问路径和已核实的主机密钥 |
| `SUQI_SSH_CREDENTIALS_ID` | 对上述 SSH 路径授权的 Jenkins SSH 私钥凭据 ID |
| 目标机 ACR 拉取凭据 | 部署账号通过现有获准的凭据管理方式读取项目镜像，流水线使用目标机的拉取身份 |

流水线从 SCM 读取实际提交，构建 `linux/amd64` 镜像，先通过隔离容器检查首页，再按 Git 提交打标签推送 ACR。`image-ref.txt` 保存不可变镜像摘要。目标机按摘要拉取，校验架构和镜像中的提交标签，并在无网络、无宿主机端口映射的临时容器中重复首页检查。这份流水线的所有阶段仅用于预演。

## 项目容器

通过 JumpServer 确认测试机可登录后，将新版 Compose 配置同步到 `/data1/weifeng/suqi/source`。使用已通过预演的镜像摘要和测试机网卡上已分配的私网 IP。确认调用方到该地址有路由，ECS 安全组的 TCP `5001` 入站来源限制为获准的调用方地址或安全组。

```sh
set -eu
export SUQI_IMAGE='registry.example.com/namespace/w-suqi@sha256:<verified-digest>'
export SUQI_BIND_IP='<test-server-private-ip>'
ip -4 -o addr show | awk -v target="$SUQI_BIND_IP" '
    { split($4, address, "/"); if (address[1] == target) found = 1 }
    END { exit !found }
'
listeners=$(ss -H -ltn 'sport = :5001')
test -z "$listeners"
docker compose config --quiet
docker compose create --no-recreate --pull never suqi
test "$(docker inspect w-suqi --format '{{.HostConfig.NetworkMode}}')" = host
```

创建后先从 JumpServer 新开会话复核连通性。通过后执行 `docker start w-suqi`，从测试机和实际调用方分别请求 `http://<test-server-private-ip>:5001/`。再次验证 JumpServer 可以登录，并确认 Docker 网络列表未新增项目网桥。若容器检查报告了旧网络模式，先确认该容器属于本次预演并完成清理，再按新版配置创建。

公网 Qwen 接入需要通过环境变量提供 `QWEN_CHAT_COMPLETIONS_URL`（完整 HTTPS `chat/completions` URL）、`QWEN_MODEL`（供应方模型 ID）和 `QWEN_API_KEY`（由已授权的秘密存储注入）。正式业务验收需要配置真实点位、完成两类接口，并用供应方支持的图片请求分别验证单图和双图推理。首页冒烟只验证容器可启动并提供网页。
