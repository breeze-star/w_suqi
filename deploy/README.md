# w-suqi 测试环境预演

目标为通过已授权访问路径连接的测试机 `server-1`。服务器上的项目目录为 `/data1/weifeng/suqi`。容器名 `w-suqi`，回环预演端口 `127.0.0.1:5001` 映射至容器 `5001`，项目目录只读挂载到 `/data/suqi`，程序从镜像内 `/app` 启动。预演复用 Docker 已有的 `bridge` 网络，以避免新增网段与宿主机路由冲突。

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

拿到已通过预演的镜像后，可从目标机 `/data1/weifeng/suqi/source` 执行以下命令创建 `w-suqi`。`create` 产出待启动容器。

```sh
export SUQI_IMAGE='registry.example.com/namespace/w-suqi@sha256:<verified-digest>'
docker compose create --pull never suqi
docker inspect w-suqi --format '{{.State.Status}} {{json .HostConfig.PortBindings}} {{json .Mounts}}'
```

公网 Qwen 接入需要通过环境变量提供 `QWEN_CHAT_COMPLETIONS_URL`（完整 HTTPS `chat/completions` URL）、`QWEN_MODEL`（供应方模型 ID）和 `QWEN_API_KEY`（由已授权的秘密存储注入）。正式业务验收需要配置真实点位、完成两类接口，并用供应方支持的图片请求分别验证单图和双图推理。首页冒烟只验证容器可启动并提供网页。
