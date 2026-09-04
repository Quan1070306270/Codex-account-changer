#!/bin/bash
set -euo pipefail

AUTH_BASE64_FILE="${1:-}"
ACCOUNT_EMAIL="${2:-ChatGPT 账号}"
DEFAULT_MODEL="${3:-gpt-5.6-terra}"
SERVER_ACCOUNT_ID="${4:-}"
SUPPORT_DIR="$HOME/Library/Application Support/GPTAccountSwitcher"
CODEX_DIR="$HOME/.codex"
TARGET_AUTH="$CODEX_DIR/auth.json"
TARGET_CONFIG="$CODEX_DIR/config.toml"
SERVER_AUTH_TEMP="$CODEX_DIR/.auth.server.json"
INSTALL_AUTH_TEMP="$CODEX_DIR/.auth.switching.json"
TEMP_CONFIG="$CODEX_DIR/.config.switching.toml"
ACCOUNT_CACHE_DIR="$SUPPORT_DIR/accounts"
SWITCH_LOCK="$SUPPORT_DIR/.switch.lock"
LOCK_ACQUIRED=false

cleanup() {
  rm -f "$SERVER_AUTH_TEMP" "$INSTALL_AUTH_TEMP" "$TEMP_CONFIG"
  if [[ "$LOCK_ACQUIRED" == true ]]; then rm -rf "$SWITCH_LOCK"; fi
}
trap cleanup EXIT

if [[ ! -s "$AUTH_BASE64_FILE" ]]; then
  echo "账号凭据为空" >&2
  exit 1
fi
if [[ ! "$DEFAULT_MODEL" =~ ^[a-z0-9._-]+$ ]]; then
  echo "默认模型格式无效" >&2
  exit 1
fi
if [[ ! "$SERVER_ACCOUNT_ID" =~ ^[0-9a-fA-F-]+$ ]]; then
  echo "账号编号无效，请更新切换器" >&2
  exit 1
fi

mkdir -p "$CODEX_DIR" "$SUPPORT_DIR/backups" "$ACCOUNT_CACHE_DIR"
chmod 700 "$CODEX_DIR" "$SUPPORT_DIR" "$SUPPORT_DIR/backups" "$ACCOUNT_CACHE_DIR"
if ! mkdir "$SWITCH_LOCK" 2>/dev/null; then
  echo "另一次账号切换正在执行，本次请求已安全合并"
  exit 0
fi
LOCK_ACQUIRED=true

auth_account_id() {
  /usr/bin/plutil -extract tokens.account_id raw -o - "$1" 2>/dev/null || true
}

valid_auth_file() {
  local path="$1"
  local expected_id="${2:-}"
  [[ -s "$path" ]] || return 1
  local mode account_id refresh_token
  mode=$(/usr/bin/plutil -extract auth_mode raw -o - "$path" 2>/dev/null || true)
  account_id=$(auth_account_id "$path")
  refresh_token=$(/usr/bin/plutil -extract tokens.refresh_token raw -o - "$path" 2>/dev/null || true)
  [[ "$mode" == "chatgpt" && -n "$account_id" && -n "$refresh_token" ]] || return 1
  [[ -z "$expected_id" || "$account_id" == "$expected_id" ]]
}

cache_path_for_account() {
  local account_id="$1"
  local cache_key
  cache_key=$(printf '%s' "$account_id" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
  printf '%s/%s/auth.json' "$ACCOUNT_CACHE_DIR" "$cache_key"
}

cache_auth_file() {
  local source="$1"
  local account_id
  account_id=$(auth_account_id "$source")
  [[ -n "$account_id" ]] || return 1
  local destination temporary
  destination=$(cache_path_for_account "$account_id")
  temporary="$destination.$$.tmp"
  mkdir -p "$(dirname "$destination")"
  chmod 700 "$(dirname "$destination")"
  cp -p "$source" "$temporary"
  chmod 600 "$temporary"
  /bin/mv -f "$temporary" "$destination"
}

auth_refresh_key() {
  local path="$1"
  local refreshed
  refreshed=$(/usr/bin/plutil -extract last_refresh raw -o - "$path" 2>/dev/null || true)
  if [[ -n "$refreshed" ]]; then
    # Whole-second RFC3339 values compare lexicographically and avoid unequal
    # fractional precision (for example .12Z versus .120000000Z).
    printf '%s' "${refreshed%%.*}"
  else
    # Old auth files may not have last_refresh. Keep their filesystem-time
    # fallback below normal RFC3339 values so they cannot mask a fresh login.
    printf '0000-%020d' "$(/usr/bin/stat -f '%m' "$path" 2>/dev/null || printf '0')"
  fi
}

find_newest_auth() {
  local expected_id="$1"
  local server_auth="$2"
  local selected="$server_auth"
  local selected_key candidate candidate_key cached
  selected_key=$(auth_refresh_key "$selected")
  cached=$(cache_path_for_account "$expected_id")

  while IFS= read -r candidate; do
    [[ -n "$candidate" && "$candidate" != "$selected" ]] || continue
    if valid_auth_file "$candidate" "$expected_id"; then
      candidate_key=$(auth_refresh_key "$candidate")
      if [[ "$candidate_key" > "$selected_key" ]]; then
        selected="$candidate"
        selected_key="$candidate_key"
      fi
    fi
  done < <(
    printf '%s\n' "$TARGET_AUTH"
    printf '%s\n' "$cached"
    /usr/bin/find "$SUPPORT_DIR/backups" -name 'auth-*.json' -type f -print 2>/dev/null
  )

  printf '%s' "$selected"
}

collect_descendants() {
  local parent_pid="$1"
  local child_pid
  for child_pid in $(/usr/bin/pgrep -P "$parent_pid" 2>/dev/null || true); do
    collect_descendants "$child_pid"
  done
  printf '%s\n' "$parent_pid"
}

stop_chatgpt() {
  local app_tree=""
  local app_pid
  for app_pid in $(/usr/bin/pgrep -x ChatGPT 2>/dev/null || true); do
    app_tree="$app_tree $(collect_descendants "$app_pid")"
  done
  /usr/bin/osascript -e 'tell application "ChatGPT" to quit' >/dev/null 2>&1 || true
  for _ in {1..30}; do
    /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1 || break
    sleep 0.5
  done
  if /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
    for app_pid in $app_tree; do /bin/kill -TERM "$app_pid" >/dev/null 2>&1 || true; done
    sleep 2
  fi
  if /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
    /usr/bin/pkill -KILL -x ChatGPT >/dev/null 2>&1 || true
    sleep 1
  fi
  if /usr/bin/pgrep -x ChatGPT >/dev/null 2>&1; then
    echo "无法完全关闭 ChatGPT App，已取消切换以保护登录状态" >&2
    return 1
  fi
}

/usr/bin/base64 -D < "$AUTH_BASE64_FILE" > "$SERVER_AUTH_TEMP"
chmod 600 "$SERVER_AUTH_TEMP"
if ! valid_auth_file "$SERVER_AUTH_TEMP"; then
  echo "服务器账号凭据校验失败" >&2
  exit 1
fi
TARGET_OPENAI_ACCOUNT_ID=$(auth_account_id "$SERVER_AUTH_TEMP")

stop_chatgpt

# App 完全退出后再保存当前文件，确保捕获 Codex 自动刷新后的最新凭据。
if valid_auth_file "$TARGET_AUTH"; then
  cache_auth_file "$TARGET_AUTH"
fi

SOURCE_AUTH="$SERVER_AUTH_TEMP"
# Compare every valid copy even when the App already shows the target account.
# A same-account retry must be able to replace a stale current credential.
SOURCE_AUTH=$(find_newest_auth "$TARGET_OPENAI_ACCOUNT_ID" "$SERVER_AUTH_TEMP")

if [[ "$SOURCE_AUTH" != "$TARGET_AUTH" ]]; then
  if [[ -f "$TARGET_AUTH" ]]; then
    BACKUP_PATH="$SUPPORT_DIR/backups/auth-$(date '+%Y%m%d-%H%M%S').json"
    cp -p "$TARGET_AUTH" "$BACKUP_PATH"
    chmod 600 "$BACKUP_PATH"
  fi
  cp -p "$SOURCE_AUTH" "$INSTALL_AUTH_TEMP"
  chmod 600 "$INSTALL_AUTH_TEMP"
  /bin/mv -f "$INSTALL_AUTH_TEMP" "$TARGET_AUTH"
  chmod 600 "$TARGET_AUTH"
fi
cache_auth_file "$TARGET_AUTH"

# Codex 会把新任务的模型从 config.toml 载入，必须在重新打开 App 前改好。
if [[ -f "$TARGET_CONFIG" ]]; then
  /usr/bin/awk -v selected_model="$DEFAULT_MODEL" '
    BEGIN { in_root = 1; wrote_model = 0; wrote_store = 0 }
    /^[[:space:]]*\[/ {
      if (in_root && !wrote_store) { print "cli_auth_credentials_store = \"file\""; wrote_store = 1 }
      if (in_root && !wrote_model) { print "model = \"" selected_model "\""; wrote_model = 1 }
      in_root = 0
    }
    in_root && /^[[:space:]]*cli_auth_credentials_store[[:space:]]*=/ {
      if (!wrote_store) { print "cli_auth_credentials_store = \"file\""; wrote_store = 1 }
      next
    }
    in_root && /^[[:space:]]*model[[:space:]]*=/ {
      if (!wrote_model) { print "model = \"" selected_model "\""; wrote_model = 1 }
      next
    }
    { print }
    END {
      if (!wrote_store) print "cli_auth_credentials_store = \"file\""
      if (!wrote_model) print "model = \"" selected_model "\""
    }
  ' "$TARGET_CONFIG" > "$TEMP_CONFIG"
else
  printf 'cli_auth_credentials_store = "file"\nmodel = "%s"\n' "$DEFAULT_MODEL" > "$TEMP_CONFIG"
fi
/bin/mv -f "$TEMP_CONFIG" "$TARGET_CONFIG"
chmod 600 "$TARGET_CONFIG"

STATE_PATH="$SUPPORT_DIR/state.json"
STATE_PLIST="$SUPPORT_DIR/state.plist.tmp"
rm -f "$STATE_PATH" "$STATE_PLIST"
/usr/bin/plutil -create xml1 "$STATE_PLIST"
/usr/bin/plutil -insert activeAccountEmail -string "$ACCOUNT_EMAIL" "$STATE_PLIST"
/usr/bin/plutil -insert activeAccountId -string "$TARGET_OPENAI_ACCOUNT_ID" "$STATE_PLIST"
/usr/bin/plutil -insert serverAccountId -string "$SERVER_ACCOUNT_ID" "$STATE_PLIST"
/usr/bin/plutil -insert defaultModel -string "$DEFAULT_MODEL" "$STATE_PLIST"
/usr/bin/plutil -insert switchedAt -string "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$STATE_PLIST"
/usr/bin/plutil -convert json -o "$STATE_PATH" "$STATE_PLIST"
rm -f "$STATE_PLIST"
chmod 600 "$STATE_PATH"

/usr/bin/find "$SUPPORT_DIR/backups" -name 'auth-*.json' -type f -exec ls -1t {} + 2>/dev/null \
  | /usr/bin/tail -n +21 \
  | while IFS= read -r old_backup; do rm -f "$old_backup"; done

/usr/bin/open -a ChatGPT
echo "已切换到 $ACCOUNT_EMAIL"
