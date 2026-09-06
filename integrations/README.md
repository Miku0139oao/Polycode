# Polycode：ChatGPT 訂閱與 Cursor 後端

保留原版 Grok Build 全螢幕 TUI，由你選擇 **原生 Grok、Codex agent、Cursor agent**。為便於追蹤上游，底層 Rust crate／二進位與 `.grok` 原生設定名稱仍保留；Polycode 是本 fork 的專案與啟動入口名稱，不會覆寫已安裝的 `grok.exe`。Codex/Cursor 模式使用各自官方 CLI 的登入，不需要另外輸入 OpenAI 或 Anthropic 模型 API key。

## Windows 上啟動（本機已建置的 WSL 版本）

在 PowerShell 執行：

```powershell
# 先完成官方登入（已登入可略過）
codex login
# Cursor 請使用官方 Cursor CLI 的 agent login，勿誤用 Grok 的 agent.exe。

# 切換後端；Project 指向你要工作的專案
.\polycode.ps1 -Backend codex -Project D:\my-project
.\polycode.ps1 -Backend cursor -Project D:\my-project
.\polycode.ps1 -Backend native -Project D:\my-project
```

預設 WSL 發行版為 `archlinux`，二進位為 `/root/grok-build-target/debug/xai-grok-pager`。可用 `-Distro`、`-Binary` 覆寫。Codex 安裝位置不同時傳 `-CodexExecutable`；Cursor 傳 `-CursorDirectory`（包含官方 `node.exe`、`index.js` 的版本目錄）。Launcher 不更改你的全域 Grok／Codex／Cursor 設定，也不自動更換模型計費來源。

恢復指定外部會話可加 `-Resume SESSION_ID`。`-Backend native` 會明確忽略 `[external_acp]`，不是發生錯誤時自動回退。

此 Windows 路徑使用 **WSL TUI → Windows ACP bridge → 官方 Windows agent**，沿用 Windows 上已有的登入。專案必須位於 `/mnt/<磁碟>/` 對應的 Windows 磁碟；Linux-only `/home/...` 專案請使用 Linux 版官方 CLI。Bridge 只轉換結構化檔案路徑，不改寫提示文字、模型 ID 或權限選項。

WSL 必須啟用 Windows executable interoperability。若出現 `Exec format error`，請檢查 WSL interop／binfmt 設定。此機 Arch 的 systemd 沒有保留 WSLInterop 註冊，已補 `/etc/binfmt.d/WSLInterop.conf`（內容為 `:WSLInterop:M::MZ::/init:PF`）；不要改成 shell 執行任意未驗證指令。

## Linux／macOS 或自行設定

```sh
# Codex：node 與 cli.mjs 都使用絕對路徑
/path/to/xai-grok-pager \
  --acp-executable /absolute/path/to/node \
  --acp-arg=/absolute/path/to/grok-build/integrations/codex-acp/cli.mjs \
  --acp-arg=--codex-executable \
  --acp-arg=/absolute/path/to/codex \
  --acp-auth-method codex_chatgpt

# Cursor：必須是官方 Cursor agent，不要只憑 PATH 中的 agent 名稱猜測
/path/to/xai-grok-pager \
  --acp-executable /absolute/path/to/cursor-agent \
  --acp-arg=acp \
  --acp-auth-method cursor_login
```

也可使用 Grok 的 `config.toml`：

```toml
[external_acp]
executable = "/absolute/path/to/node"
args = ["/absolute/path/to/grok-build/integrations/codex-acp/cli.mjs", "--codex-executable", "/absolute/path/to/codex"]
auth_method = "codex_chatgpt"
```

CLI 的 `--acp-executable` 會整組替換設定檔命令；每個 argument 分別使用 `--acp-arg=VALUE`。不經 shell、不搜尋模糊的 executable 名稱。連線／驗證失敗會顯示錯誤，**不退回原生 Grok 或另一個付費 API**。

在 TUI 使用 `/model` 選擇後端實際提供的模型。恢復時使用 `--resume EXTERNAL_SESSION_ID`，ID 屬於該後端，不能混用 Grok、Codex 與 Cursor 的 ID。

## 訂閱與費用邊界

- **Codex**：強制 ChatGPT 登入與 OpenAI provider；每次建立會話、送出 prompt 前檢查 account 類型。拒絕 API-key／Bedrock 登入，並要求人工審批與 workspace-write sandbox。
- **Cursor**：使用官方 `cursor_login` 與帳戶用量規則。CLI 整合不是獨立的 OpenAI API key。
- **訂閱不是無限用量**。帳戶方案、模型、組織政策、額外 credits／on-demand 設定由供應商管理。若不希望超額付費，請在供應商帳戶關閉額外用量或設定限制；此介面無法代替帳戶帳單系統提供絕對費用上限。
- 不擷取瀏覽器 token，不複製 auth.json，不記錄上游原始 stderr，不顯示帳戶識別資訊。外部程序不繼承 `XAI_*`／`GROK_*` 環境值；可執行檔位置請使用明確 CLI arguments。

## 功能與限制

共用原版 TUI 的文字／Markdown 顯示、串流、工具進度、權限確認、取消、模型選擇與明確 ID 的會話恢復。權限選項只回傳後端提供的 ID；取消或過期的確認不得變成授權。Codex 的長會話恢復包含分頁歷史讀取。

Cursor 的 `ask_question`／`create_plan` 會使用原版選項與預覽介面，保持確切選項 ID，且計畫必須明確選擇 Accept 才批准；取消、自由文字或不完整答案不會冒充批准。Todo 更新合併為標準 ACP plan；task／image 擴充只顯示後端提供的摘要，不冒充 Grok 子代理或重新執行工具。Codex 選項問答也接入同一介面；secret／純自由文字問答明確不支援。

**這是替換 agent 後端，不是把 Cursor 訂閱當通用模型 API。** 外部模式下工具、MCP、sandbox、規則與記憶由官方後端掌管，不再執行 Grok 的工具迴圈。

Grok 專屬的雲端／分享／voice／rewind／worktree／原生歷史清單／hooks 設定、headless 模式與部分附件快捷流程會被明確停用，而不是假裝支援。Cursor 模式／configOptions 不等於 Grok 的 plan／yolo 指令；未適配的控制不會送出。一般程序 telemetry/Sentry 仍沿用原專案設定，這不是零網路或匿名保證。

## 建置

參考根目錄 README 的 Rust／DotSlash 需求。上游固定 Rust 1.94.0；Windows 原生 build 是上游 best-effort，這裡已在 WSL 驗證。

```sh
# 從 repository root，在 Linux/WSL 中執行
cargo +1.94.0 install dotslash --locked
CARGO_TARGET_DIR=/root/grok-build-target cargo +1.94.0 build -p xai-grok-pager-bin
```

跨 Windows/WSL checkout 時 `bin/protoc` 必須是 LF，否則 shebang 會找 `dotslash\r` 而失敗。不要修改根 `Cargo.toml`；它由上游產生。

## 驗證

```sh
cargo +1.94.0 test -p xai-grok-pager --lib -- --test-threads=4
node --test integrations/tests/*.test.mjs
cd integrations/codex-acp && npm test
node smoke.mjs  # 只做握手／驗證，不呼叫模型
```

`integrations/tests/pty_smoke.py` 搭配 `mock_acp.py` 驗證真正全螢幕 TUI 的串流與取消。`pty_live.py`、`codex-acp/live-test.mjs`、`cursor-live-test.mjs` 的真實模型測試需要明確 `--allow-subscription-usage`，會消耗少量帳戶用量。測試不自動允許未知工具請求。`live-tool-test.mjs` 只允許精確匹配的臨時 fixture 唯讀命令，並以隨機內容驗證真正工具讀取。

Windows 完整 launcher 測試使用 `tests/conpty_live.mjs`：另外安裝 test-only `node-pty`，可用 `NODE_PTY_MODULE` 指向其安裝目錄，再執行 `node integrations/tests/conpty_live.mjs --allow-subscription-usage codex`（或 `cursor`）。不需要將 node-pty 加到產品執行相依項。

本次完整測試結果與已知邊界見 [VERIFICATION.md](VERIFICATION.md)。

## 參考與設計理由

- [Codex app-server](https://developers.openai.com/codex/app-server)：官方 agent 的驗證、串流、審批與會話介面；不是 ACP，所以使用獨立 adapter。
- [Codex authentication](https://developers.openai.com/codex/auth.md)：ChatGPT 訂閱登入與 API-key 計費的區別。
- [Cursor ACP](https://cursor.com/docs/cli/acp)：官方 stdio ACP、登入、會話與互動擴充。
- [Cursor pricing](https://cursor.com/docs/account/pricing)：包含用量與額外用量規則。
- OpenCode／Pi：參考 OAuth provider、模型與串流適配方式。日後若要保留 **Grok 自己的 agent** 而直接呼叫 ChatGPT 訂閱模型，應另做專用 OAuth／Responses provider，不可只換 URL；目前先採用可直接驗證的官方 agent 整合。
