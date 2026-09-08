# GPT 一键切换账号

一个可自行部署的 ChatGPT/Codex 账号管理网站。通过 ChatGPT 官方设备授权添加账号，查看真实 Codex 剩余额度，并把指定账号一键切换到已连接的 Mac 或 Windows 电脑。

## 主要功能

- 通过 ChatGPT 官方设备授权添加多个账号。
- 查看每个账号的真实 Codex 剩余额度、刷新倒计时和 Token 用量。
- 分别显示总额度和 5 小时额度，并在悬停时估算剩余 Token。
- 显示所有 Plus 账号的总量、余额和电池式状态条。
- 汇总各设备最近 24 小时的 Token 消耗趋势和模型占比。
- 支持账号备注、额度排序、手动刷新和五分钟自动刷新。
- 支持 Mac 与 Windows 设备连接、重命名、在线状态和当前账号显示。
- 可以为单台设备或全部设备一键切换 Codex App 账号。
- 切换请求可安全重复点击，服务端会去重并保存切换记录。
- 账号登录凭据和设备令牌只保存在服务器数据卷中，不进入 Git 仓库。

## Ubuntu 部署

服务器建议使用 Ubuntu 24.04，并开放 TCP 80、443 和 UDP 443。先安装 Docker：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

克隆项目并配置：

```bash
git clone https://github.com/<你的-GitHub-用户名>/gpt-account-manager.git
cd gpt-account-manager
cp .env.example .env
nano .env
docker compose up -d --build
```

`.env` 必须填写：

- `DOMAIN`：已经解析到服务器的域名，不带 `https://`。
- `ADMIN_PASSWORD`：网站管理密码。
- `SESSION_SECRET`：至少 24 个字符，建议运行 `openssl rand -hex 32` 生成。

Caddy 会自动申请并续期 HTTPS 证书。部署完成后访问 `https://你的域名/`。

## 本地开发

```bash
pnpm install
cp .env.example .env
pnpm dev
```

网页默认位于 `http://127.0.0.1:3000`，本地账号服务默认位于 `http://127.0.0.1:3210`。

## 数据与安全

- `.env`、`.server-data/`、`.local/`、账号授权文件和设备令牌均已加入忽略规则。
- 不要把服务器中的 `/data` 数据卷复制到公开仓库。
- 仓库中的 `.env.example` 只有占位值，不包含真实密码。
