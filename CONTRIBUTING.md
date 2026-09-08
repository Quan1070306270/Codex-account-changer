# 参与开发

这个仓库主要用于保存和维护可自行部署的项目代码。提交修改时应保持现有账号、设备和接口兼容性。

## 本地准备

需要 Node.js 22.13 或更高版本及 pnpm 11。

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

不要在提交中包含真实 `.env`、账号授权文件、设备配置、服务器数据或截图中的个人信息。

## 提交前检查

```bash
pnpm typecheck
pnpm lint
pnpm test
docker build .
```

涉及 Mac 或 Windows 切换器时，还应确认：

- 重复安装不会创建重复设备或后台任务。
- 重复点击切换不会重复执行同一条指令。
- 更新不会删除 Codex 任务、项目或本机账号缓存。
- 旧版切换器仍能下载兼容的 `usage-collector.mjs`。

## 修改原则

- 不改变现有 API 字段时优先保持向后兼容。
- 外部 JSON、HTTP 和子进程响应必须进行类型约束或运行时校验。
- 不记录请求正文、Token、Cookie 或授权文件内容。
- 新功能需要补充自动化测试和对应文档。
- 不要将依赖镜像改回浮动的 `latest` 标签。
