# Wayline CLI + Skills

Hub User 向的 Wayline Agent 工具包。项目同时发布：

- `wayline-cli`：鉴权、调用 Hub Agent API、校验 Task Graph 协议并输出 JSON。
- `skills/wayline-workspace`：浏览组织并管理任务分组与 Delivery Request。
- `skills/wayline-estimate`：结合本地代码库分析需求、估算工时并生成 Task Graph Version。
- `skills/wayline-review`：审查版本差异并操作审批流程。

发布物只包含 Hub User 所需的接口、命令和 Skill。

## 开发

```bash
npm install
make build dev
make build prod
npm run check
```

`make build dev` 与 `make build prod` 会把不同的 Cloudflare Gateway 固化进产物，不接受运行时 API URL。

## 使用

```bash
./dist/dev/index.js --help
./dist/dev/index.js auth login
./dist/dev/index.js capabilities
```

鉴权凭证保存在 `~/.wayline/credentials/`，目录权限为 `0700`，凭证文件权限为 `0600`。业务工具调用输出 `wayline-cli-result/v1` JSON；帮助、登录状态和登录引导保持人类可读。

TypeScript 版本与旧 Go CLI 使用相同的凭证格式；迁移期间不要并发运行两个实现，以免旋转同一个 Refresh Token。
