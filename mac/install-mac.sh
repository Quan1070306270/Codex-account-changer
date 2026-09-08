#!/bin/bash
set -euo pipefail

SERVER_URL="${1:-}"
PAIRING_CODE="${2:-}"
SWITCHER_VERSION="1.8.0"
SUPPORT_DIR="$HOME/Library/Application Support/GPTAccountSwitcher"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/com.gpt-account-switcher.agent.plist"
CONFIG_PATH="$SUPPORT_DIR/config.json"
INSTALLATION_ID_PATH="$SUPPORT_DIR/installation.id"
INSTALL_LOCK="$SUPPORT_DIR/.install.lock"

if [[ -z "$SERVER_URL" ]]; then
  echo "缺少服务器地址。请复制网页中完整的安装命令。" >&2
  exit 1
fi

SERVER_URL="${SERVER_URL%/}"
if [[ "$SERVER_URL" != https://* && "$SERVER_URL" != http://127.0.0.1:* && "$SERVER_URL" != http://localhost:* ]]; then
  echo "远程服务器必须使用 HTTPS。" >&2
  exit 1
fi

mkdir -p "$SUPPORT_DIR" "$SUPPORT_DIR/logs" "$SUPPORT_DIR/backups" "$LAUNCH_AGENTS_DIR" "$HOME/.codex"
chmod 700 "$SUPPORT_DIR" "$SUPPORT_DIR/logs" "$SUPPORT_DIR/backups" "$HOME/.codex"
if ! mkdir "$INSTALL_LOCK" 2>/dev/null; then
  LOCK_PID=$(/bin/cat "$INSTALL_LOCK/pid" 2>/dev/null || true)
  if [[ "$LOCK_PID" =~ ^[0-9]+$ ]] && /bin/kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "另一个安装或修复过程正在运行，无需重复执行。"
    exit 0
  fi
  rm -rf "$INSTALL_LOCK"
  mkdir "$INSTALL_LOCK"
fi
printf '%s' "$$" > "$INSTALL_LOCK/pid"
cleanup() {
  rm -rf "$INSTALL_LOCK"
  rm -f "$SUPPORT_DIR"/*.download.$$ "$SUPPORT_DIR/register-response.json" "$SUPPORT_DIR/ping-response.json" "$SUPPORT_DIR/config.plist.tmp"
}
trap cleanup EXIT

if [[ -f "$INSTALLATION_ID_PATH" ]]; then
  INSTALLATION_ID=$(/bin/cat "$INSTALLATION_ID_PATH" | /usr/bin/tr -d '[:space:]')
else
  INSTALLATION_ID=$(/usr/bin/uuidgen | /usr/bin/tr -d '-' | /usr/bin/tr '[:upper:]' '[:lower:]')
fi
if [[ ! "$INSTALLATION_ID" =~ ^[a-zA-Z0-9._-]{8,128}$ ]]; then
  INSTALLATION_ID=$(/usr/bin/uuidgen | /usr/bin/tr -d '-' | /usr/bin/tr '[:upper:]' '[:lower:]')
fi
printf '%s' "$INSTALLATION_ID" > "$INSTALLATION_ID_PATH"
chmod 600 "$INSTALLATION_ID_PATH"

for script in mac-agent.sh apply-switch.sh uninstall-mac.sh usage-collector.mjs install-usage-runtime.sh; do
  DOWNLOAD_PATH="$SUPPORT_DIR/$script.download.$$"
  /usr/bin/curl -fsSL "$SERVER_URL/downloads/$script" -o "$DOWNLOAD_PATH"
  chmod 700 "$DOWNLOAD_PATH"
  /bin/mv "$DOWNLOAD_PATH" "$SUPPORT_DIR/$script"
done

echo "正在准备本机用量采集组件（首次安装可能需要几分钟）…"
/bin/bash "$SUPPORT_DIR/install-usage-runtime.sh"

DEVICE_ID=""
DEVICE_TOKEN=""
EXISTING_VALID=false
ACTIVE_SERVER_ACCOUNT_ID=""
if [[ -f "$CONFIG_PATH" ]]; then
  DEVICE_ID=$(/usr/bin/plutil -extract deviceId raw -o - "$CONFIG_PATH" 2>/dev/null || true)
  DEVICE_TOKEN=$(/usr/bin/plutil -extract deviceToken raw -o - "$CONFIG_PATH" 2>/dev/null || true)
  if [[ -n "$DEVICE_ID" && -n "$DEVICE_TOKEN" ]]; then
    PING_RESPONSE="$SUPPORT_DIR/ping-response.json"
    PING_CODE=$(/usr/bin/curl -sS -o "$PING_RESPONSE" -w "%{http_code}" --max-time 20 \
      "$SERVER_URL/api/device/ping" \
      -H "Authorization: Bearer $DEVICE_TOKEN" \
      -H "X-Switcher-Version: $SWITCHER_VERSION" \
      -H "X-Device-Installation-Id: $INSTALLATION_ID" 2>/dev/null || true)
    if [[ "$PING_CODE" == "200" ]]; then
      EXISTING_VALID=true
      ACTIVE_SERVER_ACCOUNT_ID=$(/usr/bin/plutil -extract activeAccountId raw -o - "$PING_RESPONSE" 2>/dev/null || true)
    fi
  fi
fi

if [[ "$EXISTING_VALID" != true ]]; then
  if [[ -z "$PAIRING_CODE" ]]; then
    echo "现有设备身份已失效，请从网页重新生成“连接 Mac”命令。" >&2
    exit 1
  fi
  REGISTER_RESPONSE="$SUPPORT_DIR/register-response.json"
  HTTP_CODE=$(/usr/bin/curl -sS -o "$REGISTER_RESPONSE" -w "%{http_code}" \
    -X POST "$SERVER_URL/api/device/register" \
    -H "X-Switcher-Version: $SWITCHER_VERSION" \
    --data-urlencode "code=$PAIRING_CODE" \
    --data-urlencode "installationId=$INSTALLATION_ID" \
    --data-urlencode "name=$(scutil --get ComputerName 2>/dev/null || hostname)")

  if [[ "$HTTP_CODE" != "201" ]]; then
    ERROR_MESSAGE=$(/usr/bin/plutil -extract error raw -o - "$REGISTER_RESPONSE" 2>/dev/null || echo "配对失败（HTTP $HTTP_CODE）")
    echo "$ERROR_MESSAGE" >&2
    exit 1
  fi
  DEVICE_ID=$(/usr/bin/plutil -extract deviceId raw -o - "$REGISTER_RESPONSE")
  DEVICE_TOKEN=$(/usr/bin/plutil -extract token raw -o - "$REGISTER_RESPONSE")
fi

CONFIG_PLIST="$SUPPORT_DIR/config.plist.tmp"
NEXT_CONFIG="$SUPPORT_DIR/config.json.download.$$"
rm -f "$CONFIG_PLIST" "$NEXT_CONFIG"
/usr/bin/plutil -create xml1 "$CONFIG_PLIST"
/usr/bin/plutil -insert serverUrl -string "$SERVER_URL" "$CONFIG_PLIST"
/usr/bin/plutil -insert deviceId -string "$DEVICE_ID" "$CONFIG_PLIST"
/usr/bin/plutil -insert deviceToken -string "$DEVICE_TOKEN" "$CONFIG_PLIST"
/usr/bin/plutil -insert installationId -string "$INSTALLATION_ID" "$CONFIG_PLIST"
/usr/bin/plutil -insert version -string "$SWITCHER_VERSION" "$CONFIG_PLIST"
/usr/bin/plutil -convert json -o "$NEXT_CONFIG" "$CONFIG_PLIST"
chmod 600 "$NEXT_CONFIG"
/bin/mv "$NEXT_CONFIG" "$CONFIG_PATH"

STATE_PATH="$SUPPORT_DIR/state.json"
if [[ "$EXISTING_VALID" == true && "$ACTIVE_SERVER_ACCOUNT_ID" =~ ^[0-9a-fA-F-]+$ && -s "$STATE_PATH" ]]; then
  if /usr/bin/plutil -extract serverAccountId raw -o - "$STATE_PATH" >/dev/null 2>&1; then
    /usr/bin/plutil -replace serverAccountId -string "$ACTIVE_SERVER_ACCOUNT_ID" "$STATE_PATH"
  else
    /usr/bin/plutil -insert serverAccountId -string "$ACTIVE_SERVER_ACCOUNT_ID" "$STATE_PATH"
  fi
  chmod 600 "$STATE_PATH"
fi

CODEX_CONFIG="$HOME/.codex/config.toml"
INITIAL_CONFIG_BACKUP="$SUPPORT_DIR/backups/config-before-switcher.toml"
if [[ -f "$CODEX_CONFIG" ]]; then
  if [[ ! -f "$INITIAL_CONFIG_BACKUP" ]]; then
    cp -p "$CODEX_CONFIG" "$INITIAL_CONFIG_BACKUP"
    chmod 600 "$INITIAL_CONFIG_BACKUP"
  fi
  if /usr/bin/grep -qE '^[[:space:]]*cli_auth_credentials_store[[:space:]]*=' "$CODEX_CONFIG"; then
    /usr/bin/sed -i '' -E 's/^[[:space:]]*cli_auth_credentials_store[[:space:]]*=.*/cli_auth_credentials_store = "file"/' "$CODEX_CONFIG"
  else
    TEMP_CONFIG="$SUPPORT_DIR/config.toml.tmp"
    { printf 'cli_auth_credentials_store = "file"\n'; /bin/cat "$CODEX_CONFIG"; } > "$TEMP_CONFIG"
    /bin/mv "$TEMP_CONFIG" "$CODEX_CONFIG"
  fi
else
  printf 'cli_auth_credentials_store = "file"\n' > "$CODEX_CONFIG"
fi
chmod 600 "$CODEX_CONFIG"

if [[ -f "$HOME/.codex/auth.json" && ! -f "$SUPPORT_DIR/backups/auth-before-switcher.json" ]]; then
  cp -p "$HOME/.codex/auth.json" "$SUPPORT_DIR/backups/auth-before-switcher.json"
  chmod 600 "$SUPPORT_DIR/backups/auth-before-switcher.json"
fi

rm -f "$PLIST_PATH"
/usr/bin/plutil -create xml1 "$PLIST_PATH"
/usr/bin/plutil -insert Label -string "com.gpt-account-switcher.agent" "$PLIST_PATH"
/usr/bin/plutil -insert ProgramArguments -array "$PLIST_PATH"
/usr/bin/plutil -insert ProgramArguments.0 -string "$SUPPORT_DIR/mac-agent.sh" "$PLIST_PATH"
/usr/bin/plutil -insert RunAtLoad -bool true "$PLIST_PATH"
/usr/bin/plutil -insert KeepAlive -bool true "$PLIST_PATH"
/usr/bin/plutil -insert ProcessType -string "Background" "$PLIST_PATH"
/usr/bin/plutil -insert ThrottleInterval -integer 5 "$PLIST_PATH"
/usr/bin/plutil -insert StandardOutPath -string "$SUPPORT_DIR/logs/agent.log" "$PLIST_PATH"
/usr/bin/plutil -insert StandardErrorPath -string "$SUPPORT_DIR/logs/agent-error.log" "$PLIST_PATH"
chmod 600 "$PLIST_PATH"

DOMAIN_TARGET="gui/$(id -u)"
/bin/launchctl bootout "$DOMAIN_TARGET/com.gpt-account-switcher.agent" >/dev/null 2>&1 || true
/bin/launchctl enable "$DOMAIN_TARGET/com.gpt-account-switcher.agent"
/bin/launchctl bootstrap "$DOMAIN_TARGET" "$PLIST_PATH"
/bin/launchctl kickstart -k "$DOMAIN_TARGET/com.gpt-account-switcher.agent"

if [[ "$EXISTING_VALID" == true ]]; then
  echo "更新完成。此 Mac 已保持原连接，不会创建重复设备。"
else
  echo "安装完成。现在可以在网页上一键切换此 Mac 的 Codex 账号。"
fi
