# w_suqi

视觉检测工作台原型，包含道路坑洼、河道大面积植被、秸秆禁烧三类巡检预设，以及双图建筑变化检测。

单图 `/api/detect` 使用 `terms` 选择目标，预设目标由服务端补充判定规则。双图 `/api/change` 上传 `imageA` 和 `imageB`，建筑结果的 `type` 为 `added` 或 `removed`，`image_role` 分别对应 `b` 或 `a`。两类接口的 `bbox_2d` 均为对应输入图的 0–1000 归一化坐标。

本地使用 `node --env-file=.env server.mjs` 启动，默认地址为 `http://127.0.0.1:4317`。参照 [环境变量示例](.env.example) 在本机配置模型地址、模型 ID 和 API 密钥。

- [视觉检测服务实施说明](视觉检测服务实施说明.md)
- [测试环境与 Jenkins 预演](deploy/README.md)
