# Polycode：同一個原生 TUI，選擇模型來源

**Windows 原生候選版驗證中；已發佈的 v0.2.0 WSL 包有已知故障。** 目標是保留 Grok Build **真正的 agent engine、工具迴圈、MCP、權限、sandbox、原生 sessions 與功能**，只切換 Grok／ChatGPT 訂閱／實驗性 Cursor 訂閱的模型來源。不是只保留畫面，也不是用 Codex／Cursor agent 代替 Grok。

舊版 `d549db3` 外部 ACP 原型已被否決為最終架構。它的 Rust／adapter 測試與真實登入紀錄只證明舊路徑；詳見 [VERIFICATION.md](VERIFICATION.md)。新的 Windows 建置與验收方式見 [WINDOWS_VALIDATION.md](WINDOWS_VALIDATION.md)；離線測試不能代替瀏覽器 OAuth 或真實生成驗收。

## 安裝與啟動

目前 v0.2.0 是 WSL 包，使用者回報三個 provider 無法使用。新的 Windows 原生包通過真實驗收前，暫停推薦公開一鍵安裝。

目標為 Windows 10 22H2／Windows 11 x64、PowerShell 5.1／7。套件包含 MSVC 原生 TUI、Windows Bun 與本地 provider service，不要求 WSL、Rust、Node 或外部 provider CLI。

[根目錄 README](../README.md#install-polycode-windows-native) 說明隔離安裝；[Windows validation](WINDOWS_VALIDATION.md) 記錄驗收門檻。舊 WSL 開發紀錄不能代表新包的驗收結果。
以下為待驗證的原生版使用方式：

```powershell
polycode                                  # 目前目錄，直接進入原生 provider UI
polycode -Project D:\my-project             # 指定專案
polycode -Backend codex -Project D:\my-project
polycode -Backend cursor -Project D:\my-project
polycode -Backend native -Project D:\my-project
```

`-Backend` 是**可省略的初始選擇偏好**（預設 `auto`）；`native` 指 Grok 模型來源，`codex` 指 ChatGPT 訂閱模型 transport。三者都必須使用 Grok 原生 engine，不是 external-agent 模式。底層 Rust crate、上游設定與 `grok` 命名仍保留，Polycode 是獨立入口。

### TUI 內的必要流程（尚待端到端驗證）

1. 未登入也能開啟 provider UI，選擇 Grok、ChatGPT 或實驗性 Cursor。
2. 在 TUI 選擇登入，由 TUI 開啟供應商瀏覽器授權頁；完成後回到**同一個 TUI**，不需先登入 CLI 或重啟。
3. 取得帳戶實際可用的模型，再明確選擇模型；登入成功不代表自動切換。之後可在同一原生 session 切換來源／模型，保留歷史、工具、MCP 與權限狀態。
4. 登入失敗、取消、逾時或舊回覆不得切換模型、改用另一個帳戶或付費 API。執行中的 turn 須完成或明確取消後才切換，不得遺失工具結果或審批。

目前 Rust 工作草稿提供 `/provider`、`/login [grok|codex|cursor]`、`/provider refresh`、`/provider cancel`，並接入 `/model`。這是待驗證介面，不是已發佈功能保證。`-Resume` 必須恢復 **Grok 原生 session**，不得沿用舊文件中的 Codex／Cursor 外部 session ID。

## 原生架構與功能邊界

`PowerShell → Windows Bun + 本地 provider service → Windows 原生 Grok TUI / engine → 所選模型 transport`

本地 service 負責 OAuth、credential refresh、模型目錄及串流協定轉換，不執行 Codex／Cursor CLI，不掌管專案工具、MCP、權限或 session。模型回傳工具意圖，**由 Grok 原生權限流程決定執行或拒絕，並送回真實結果**。Cursor 的遠端工具橋接不得執行或猜測替代工具；未知內建工具須明確拒絕。

保留上游功能是驗收要求，包含 hooks、skills／plugins、worktree、rewind、原生歷史、附件、headless、cloud／分享／voice 等；各功能原有的帳戶、平台或服務條件仍適用。**不得沿用外部 ACP 模式的停用清單作為已完成原生整合。** Provider 能力差異必須明示及處理，不能靜默丟棄參數、附件、角色或假造 usage，也不能因此悄悄縮減最終需求。

### ChatGPT：推理等級相容性

真實模型目錄已出現 `ultra`，目前原生 sampler 尚無此等級。Bridge 會保留模型其餘可表示的等級，不會因這個新增選項拒絕整份目錄，也不會把 `ultra` 映射成較低等級。若模型只提供 `ultra`，或以它為預設，仍明確拒絕不相容的能力資料。這是尚待補齊的原生能力，不代表完整支援 `ultra`。

### Cursor：實驗性且有未解相容性

使用未公開、可能隨時變動的 Cursor 協定，不是官方通用模型 API；使用者已同意研究其 **協定、帳戶及服務條款風險**，這不代表供應商認可或保證帳戶安全。

目前仍在調查 system／developer／history 角色語義、遠端 agent 指令、sampling／length controls、usage、image／多模態與 native request 的相容性。文字化保存 transcript 不等於角色語義等價；離線工具往返也不證明真實後端接受。現有 transport 對未支援的控制／圖片等明確報錯，**不是功能等價完成，也不是同意移除這些需求**。詳細缺口見 [Cursor checkpoint](native-provider/cursor/README.md)。

## 登入資料、安全與費用

- Polycode 自行從供應商授權流程取得憑證，存於 **WSL** `${XDG_DATA_HOME:-$HOME/.local/share}/polycode/auth/`，與官方 CLI 的帳戶檔分離；不要提交或分享此目錄。
- Credential store 草稿使用 provider 分檔、跨程序鎖、revision 與原子提交協調 refresh／登入更新；新建目錄／檔案權限為 `0700`／`0600`。這是本機敏感檔案，**不是加密保管庫**；鎖與 revision 也不等於 live token rotation 已驗證。
- 不擷取瀏覽器或 CLI credential，不複製 `auth.json`，不使用第三方 token proxy。不要在 issue、日誌或截圖公開 token、授權 callback 或原始敏感 payload。本地 loopback service 不應對外公開。
- 不繞過配額、帳單或帳戶限制，不默默切換到 metered API、別的模型／來源。登入、目錄、generation 或用量錯誤必須明確回報。
- **訂閱不代表無限或零額外費用**。模型資格、額度、on-demand／credits 及組織政策仍由供應商管理；有費用疑慮請先在帳戶停用額外用量或設定限制。Polycode 不更改計費設定，也不能保證帳戶端絕無超額費用。
- Grok 自己的登入與用量規則仍適用。上游 telemetry／Sentry 設定也不是匿名或零網路保證。

## 開發者：整合後的來源建置

先依 [根目錄 README](../README.md#building-from-source) 準備 pinned Rust／DotSlash。以下必須在**原生 Rust 修改、service 及 launcher 已合併的 checkout**執行；不適用公開 ACP 原型或只有文件的分支。

```sh
# WSL Arch；repository root
CARGO_TARGET_DIR=/root/grok-build-target cargo +1.94.0 build -p xai-grok-pager-bin
npm ci --prefix integrations/native-provider
node --test integrations/native-provider/test/*.test.mjs integrations/native-provider/cursor/provider.test.mjs
```

建置成功後，Windows PowerShell 的來源入口草稿為：

```powershell
.\polycode.ps1 -Project D:\my-project -Distro archlinux -Binary /root/grok-build-target/debug/xai-grok-pager -Runtime /usr/sbin/bun
```

`-Binary`／`-Runtime` 是 WSL 絕對路徑；來源開發需自行備妥 Bun，正式套件預定內含 runtime。`bin/protoc` 必須為 LF；不要修改上游生成的根 `Cargo.toml`。建置或離線測試通過不能取代真正 native TUI／OAuth／模型與工具測試。

## 來源與致謝

- [Grok Build](https://github.com/xai-org/grok-build)：原生 TUI、engine 與工具；[上游 user guide](../crates/codegen/xai-grok-pager/docs/user-guide/)。
- [OpenAI authentication](https://developers.openai.com/codex/auth.md)：ChatGPT 與 API-key 計費方式不同；借用授權協定不代表執行官方 CLI。
- [Cursor pricing](https://cursor.com/docs/account/pricing)：帳戶用量規則。[官方 ACP 文件](https://cursor.com/docs/cli/acp)屬舊原型背景，不是原生 transport 的相容性證明。
- OpenCode／Pi 的 OAuth／streaming 設計參考，以及 [Cursor provenance 與保留授權](native-provider/cursor/PROVENANCE.md)。
- [Apache-2.0 LICENSE](../LICENSE)、[THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES)與上游 crate／vendored notices 仍適用；發佈包還須保留 Bun、npm 與改編 Cursor transport 的授權文件。
