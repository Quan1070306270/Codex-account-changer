#!/bin/bash
set -u

SWITCHER_VERSION="1.8.0"
SUPPORT_DIR="$HOME/Library/Application Support/GPTAccountSwitcher"
CONFIG_PATH="$SUPPORT_DIR/config.json"
PROCESSED_DIR="$SUPPORT_DIR/processed-commands"
POLL_SECONDS=5
USAGE_PID=""
trap 'if [[ -n "$USAGE_PID" ]]; then kill "$USAGE_PID" 2>/dev/null || true; fi; exit 0' TERM INT EXIT

ensure_usage_collector() {
  if [[ -n "$USAGE_PID" ]] && kill -0 "$USAGE_PID" 2>/dev/null; then return; fi
  if [[ -x "$SUPPORT_DIR/usage-runtime/bin/node" && -f "$SUPPORT_DIR/usage-collector.mjs" ]]; then
    "$SUPPORT_DIR/usage-runtime/bin/node" --max-old-space-size=96 "$SUPPORT_DIR/usage-collector.mjs" "$SUPPORT_DIR" "$$" >/dev/null 2>&1 &
    USAGE_PID=$!
  fi
}

read_config() {
  SERVER_URL=$(/usr/bin/plutil -extract serverUrl raw -o - "$CONFIG_PATH" 2>/dev/null) || return 1
  DEVICE_TOKEN=$(/usr/bin/plutil -extract deviceToken raw -o - "$CONFIG_PATH" 2>/dev/null) || return 1
  INSTALLATION_ID=$(/usr/bin/plutil -extract installationId raw -o - "$CONFIG_PATH" 2>/dev/null || true)
}

current_codex_account_header() {
  local auth_path="$HOME/.codex/auth.json"
  local auth_mode account_id
  auth_mode=$(/usr/bin/plutil -extract auth_mode raw -o - "$auth_path" 2>/dev/null || true)
  account_id=$(/usr/bin/plutil -extract tokens.account_id raw -o - "$auth_path" 2>/dev/null || true)
  if [[ "$auth_mode" == "chatgpt" && "$account_id" =~ ^[A-Za-z0-9._:-]{1,200}$ ]]; then
    printf '%s' "$account_id"
  else
    printf 'signed-out'
  fi
}

sync_credentials() {
  local state_path="$SUPPORT_DIR/state.json"
  local auth_path="$HOME/.codex/auth.json"
  [[ -s "$state_path" && -s "$auth_path" ]] || return 0
  local server_account_id openai_account_id auth_account_id auth_mode refresh_token auth_hash sync_key
  server_account_id=$(/usr/bin/plutil -extract serverAccountId raw -o - "$state_path" 2>/dev/null || true)
  openai_account_id=$(/usr/bin/plutil -extract activeAccountId raw -o - "$state_path" 2>/dev/null || true)
  auth_account_id=$(/usr/bin/plutil -extract tokens.account_id raw -o - "$auth_path" 2>/dev/null || true)
  auth_mode=$(/usr/bin/plutil -extract auth_mode raw -o - "$auth_path" 2>/dev/null || true)
  refresh_token=$(/usr/bin/plutil -extract tokens.refresh_token raw -o - "$auth_path" 2>/dev/null || true)
  [[ "$server_account_id" =~ ^[0-9a-fA-F-]+$ && "$auth_mode" == "chatgpt" && -n "$refresh_token" && "$auth_account_id" == "$openai_account_id" ]] || return 0
  auth_hash=$(/usr/bin/shasum -a 256 "$auth_path" | /usr/bin/awk '{print $1}')
  sync_key="$server_account_id:$auth_hash"
  [[ "$(/bin/cat "$SUPPORT_DIR/last-auth-sync" 2>/dev/null || true)" == "$sync_key" ]] && return 0

  local cache_key cache_path cache_temp
  cache_key=$(printf '%s' "$auth_account_id" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')
  cache_path="$SUPPORT_DIR/accounts/$cache_key/auth.json"
  cache_temp="$cache_path.$$.tmp"
  mkdir -p "$(dirname "$cache_path")"
  chmod 700 "$SUPPORT_DIR/accounts" "$(dirname "$cache_path")"
  cp -p "$auth_path" "$cache_temp"
  chmod 600 "$cache_temp"
  /bin/mv -f "$cache_temp" "$cache_path"

  local encoded_path body_path body_plist http_code
  encoded_path="$SUPPORT_DIR/auth-sync.base64"
  body_path="$SUPPORT_DIR/auth-sync.json"
  body_plist="$SUPPORT_DIR/auth-sync.plist.tmp"
  /usr/bin/base64 < "$auth_path" > "$encoded_path"
  rm -f "$body_path" "$body_plist"
  /usr/bin/plutil -create xml1 "$body_plist"
  /usr/bin/plutil -insert accountId -string "$server_account_id" "$body_plist"
  /usr/bin/plutil -insert authBase64 -string "$(/bin/cat "$encoded_path")" "$body_plist"
  /usr/bin/plutil -convert json -o "$body_path" "$body_plist"
  chmod 600 "$encoded_path" "$body_path"
  local headers=(
    -H "Authorization: Bearer $DEVICE_TOKEN"
    -H "X-Switcher-Version: $SWITCHER_VERSION"
  )
  if [[ -n "$INSTALLATION_ID" ]]; then headers+=(-H "X-Device-Installation-Id: $INSTALLATION_ID"); fi
  http_code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 20 \
    -X POST "$SERVER_URL/api/device/credentials" "${headers[@]}" \
    -H "Content-Type: application/json" --data-binary "@$body_path" 2>/dev/null || true)
  if [[ "$http_code" == "204" ]]; then
    printf '%s' "$sync_key" > "$SUPPORT_DIR/last-auth-sync"
    chmod 600 "$SUPPORT_DIR/last-auth-sync"
  fi
  rm -f "$encoded_path" "$body_path" "$body_plist"
}

acknowledge() {
  local command_id="$1"
  local success="$2"
  local message="${3:-}"
  local ack_file="$SUPPORT_DIR/ack.json"
  local ack_plist="$SUPPORT_DIR/ack.plist.tmp"
  rm -f "$ack_file" "$ack_plist"
  /usr/bin/plutil -create xml1 "$ack_plist"
  /usr/bin/plutil -insert ok -bool "$success" "$ack_plist"
  if [[ -n "$message" ]]; then
    /usr/bin/plutil -insert error -string "${message:0:500}" "$ack_plist"
  fi
  /usr/bin/plutil -convert json -o "$ack_file" "$ack_plist"
  local headers=(
    -H "Authorization: Bearer $DEVICE_TOKEN"
    -H "X-Switcher-Version: $SWITCHER_VERSION"
  )
  if [[ -n "$INSTALLATION_ID" ]]; then
    headers+=(-H "X-Device-Installation-Id: $INSTALLATION_ID")
  fi
  /usr/bin/curl -fsS -X POST "$SERVER_URL/api/device/commands/$command_id/ack" \
    "${headers[@]}" \
    -H "Content-Type: application/json" \
    --data-binary "@$ack_file" >/dev/null || true
  rm -f "$ack_file" "$ack_plist"
}

command_was_processed() {
  [[ "$1" =~ ^[0-9a-fA-F-]+$ && -f "$PROCESSED_DIR/$1" ]]
}

mark_command_processed() {
  [[ "$1" =~ ^[0-9a-fA-F-]+$ ]] || return 1
  local marker_temp="$PROCESSED_DIR/$1.$$.tmp"
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker_temp"
  chmod 600 "$marker_temp"
  /bin/mv -f "$marker_temp" "$PROCESSED_DIR/$1"
}

mkdir -p "$SUPPORT_DIR" "$PROCESSED_DIR"
chmod 700 "$SUPPORT_DIR" "$PROCESSED_DIR"
/usr/bin/find "$PROCESSED_DIR" -type f -mtime +7 -delete 2>/dev/null || true

while true; do
  ensure_usage_collector
  if ! read_config; then
    echo "无法读取切换器配置。"
    sleep 30
    continue
  fi

  sync_credentials

  RESPONSE_FILE="$SUPPORT_DIR/next-command.json"
  REQUEST_HEADERS=(
    -H "Authorization: Bearer $DEVICE_TOKEN"
    -H "X-Switcher-Version: $SWITCHER_VERSION"
    -H "X-Codex-Active-Account: $(current_codex_account_header)"
  )
  if [[ -n "$INSTALLATION_ID" ]]; then
    REQUEST_HEADERS+=(-H "X-Device-Installation-Id: $INSTALLATION_ID")
  fi
  HTTP_CODE=$(/usr/bin/curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" \
    "$SERVER_URL/api/device/commands/next" \
    "${REQUEST_HEADERS[@]}" 2>/dev/null) || HTTP_CODE="000"

  if [[ "$HTTP_CODE" == "200" ]]; then
    COMMAND_ID=$(/usr/bin/plutil -extract id raw -o - "$RESPONSE_FILE" 2>/dev/null || true)
    COMMAND_TYPE=$(/usr/bin/plutil -extract type raw -o - "$RESPONSE_FILE" 2>/dev/null || true)
    ACCOUNT_EMAIL=$(/usr/bin/plutil -extract accountEmail raw -o - "$RESPONSE_FILE" 2>/dev/null || true)
    DEFAULT_MODEL=$(/usr/bin/plutil -extract defaultModel raw -o - "$RESPONSE_FILE" 2>/dev/null || true)
    SERVER_ACCOUNT_ID=$(/usr/bin/plutil -extract accountId raw -o - "$RESPONSE_FILE" 2>/dev/null || true)
    AUTH_FILE="$SUPPORT_DIR/pending-auth.base64"
    /usr/bin/plutil -extract authBase64 raw -o "$AUTH_FILE" "$RESPONSE_FILE" 2>/dev/null || true
    chmod 600 "$AUTH_FILE" 2>/dev/null || true

    if [[ -z "$COMMAND_ID" || ! "$COMMAND_ID" =~ ^[0-9a-fA-F-]+$ || "$COMMAND_TYPE" != "switch-account" || -z "$SERVER_ACCOUNT_ID" || ! -s "$AUTH_FILE" ]]; then
      [[ -n "$COMMAND_ID" ]] && acknowledge "$COMMAND_ID" false "切换指令格式无效"
    elif command_was_processed "$COMMAND_ID"; then
      acknowledge "$COMMAND_ID" true
      echo "切换指令 $COMMAND_ID 已执行，仅重试确认"
    else
      APPLY_OUTPUT=$("$SUPPORT_DIR/apply-switch.sh" "$AUTH_FILE" "$ACCOUNT_EMAIL" "$DEFAULT_MODEL" "$SERVER_ACCOUNT_ID" 2>&1)
      APPLY_STATUS=$?
      if [[ $APPLY_STATUS -eq 0 ]]; then
        mark_command_processed "$COMMAND_ID"
        acknowledge "$COMMAND_ID" true
        echo "已切换到 $ACCOUNT_EMAIL"
      else
        acknowledge "$COMMAND_ID" false "$APPLY_OUTPUT"
        echo "切换失败：$APPLY_OUTPUT" >&2
      fi
    fi
    rm -f "$AUTH_FILE"
  elif [[ "$HTTP_CODE" != "204" && "$HTTP_CODE" != "000" ]]; then
    echo "服务器返回 HTTP $HTTP_CODE" >&2
  fi

  rm -f "$RESPONSE_FILE"
  sleep "$POLL_SECONDS"
done
