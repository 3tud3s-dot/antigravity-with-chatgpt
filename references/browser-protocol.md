# ChatGPT Web Browser Interaction Protocol (`browser-protocol.md`)

本参考文档规定了 `antigravity-with-chatgpt` Skill 通过 `chrome-devtools` MCP 工具与真实 ChatGPT 网页版（Single Page Application）进行交互的底层指令规范、DOM 识别特征、等待完成逻辑及异常恢复策略。

---

## 1. 核心 MCP 工具映射速查

所有浏览器控制必须统一通过 `call_mcp_tool` 发送至 `ServerName="chrome-devtools"`：

| 工具名称 | 核心入参示例 | 用途说明 |
| :--- | :--- | :--- |
| `new_page` | `{"url": "<saved project or conversation URL>"}` | 创建专属的新 Tab，返回 `pageId` |
| `list_pages` | `{}` | 列出所有页面，用于恢复会话或获取跳转后的完整 Project conversation URL |
| `select_page` | `{"pageId": 12345, "bringToFront": false}` | 聚焦并选中目标页面上下文 |
| `take_snapshot`| `{"pageId": 12345}` | 获取当前页面的完整 a11y 树及元素动态 `uid` |
| `fill` | `{"pageId": 12345, "uid": "1_23", "value": "<complete prompt>"}` | 一次性填入完整 Prompt，但不提交 |
| `type_text` | `{"pageId": 12345, "text": "..."}` | 仅用于不触发提交的短文本字段；不得用于发送 Prompt |
| `click` | `{"pageId": 12345, "uid": "1_23"}` | 点击指定的按钮或聚焦输入框 |
| `wait_for` | `{"pageId": 12345, "text": ["Copy", "复制"]}` | 等待生成结束后的标志性文本出现 |

---

## 2. 页面元素识别基准（Accessibility Tree）

在调用 `take_snapshot(pageId)` 后，返回的文本是页面的无障碍树结构。按以下特征定位元素：

### 2.1 输入区域（Prompt Input）
- **类型/角色**：`textbox` 或 `contenteditable`
- **属性/标识**：
  - 占位符或名称通常为：`"Ask anything"`, `"Message ChatGPT"`, `"问点什么"`, `"给 ChatGPT 发送消息"`
  - 常见底层元素 ID：`prompt-textarea`
- **操作方式**：
  对 ChatGPT Prompt 必须调用一次 `fill(pageId, uid, value=<完整文本>)` 填入全部内容。不得使用 `type_text(..., submitKey="Enter")`，不得按段、按行或按逐步增长的版本输入。

### 2.2 提交按钮（Send Button）
- **类型/角色**：`button`
- **属性/标识**：
  - Accessible name 为 `"Send prompt"`, `"发送提示词"`, `"Send message"`
  - 或快照中邻近输入框末尾的箭头按钮
- **提交操作**：完整填入后重新获取快照，定位当前发送按钮的新 `uid`，只调用一次 `click`。不得同时使用 Enter 和发送按钮两种提交方式。

### 2.3 生成状态判定（Streaming Status）
- **流式生成中**：
  - 发送按钮变换为停止按钮（Accessible name 为 `"Stop streaming"`, `"停止生成"`, `"停止流式传输"`）。
- **生成完成标志**：
  - “停止生成”按钮消失。
  - 重新出现可用的发送按钮（或输入框恢复可编辑状态）。
  - 最新的回复下方出现工具栏按钮（如 `"Copy"`, `"复制"`, `"Good response"`, `"赞同"` 等）。

### 2.4 Prompt 幂等提交
每一则逻辑 Prompt 最多提交一次，初始化、普通咨询、改动验收和最终确认全部适用：

1. 提交前获取新快照，确认没有正在生成的回复，并记录最后一则用户消息。
2. 对空输入框只调用一次 `fill`，传入该 Prompt 的完整文本；多行文本也必须作为一个完整 value 填入。
3. `fill` 成功后重新获取快照，再用新的发送按钮 `uid` 点击一次。禁止在 `fill` 中附带 Enter，也禁止点击后再补一次 Enter。
4. 点击后若工具返回超时、错误或结果不明确，只允许获取一次新快照：
   - 若出现新的用户消息、停止生成按钮，或输入框已经清空，视为已经提交，绝不重发；
   - 若仍无法明确判断是否提交，立即停止并报告，绝不重新 `fill`、追加文字或发送累计版本。
5. 如果发现只提交了 Prompt 的一部分，立即停止本轮。不得发送“补全版”覆盖，因为这会在同一 conversation 中留下多个相互重复的用户消息。

---

## 3. 标准多轮交互流水线

所有新 Advisor conversation 必须从已验证的 workspace ChatGPT Project 内创建。首次发消息前，快照中必须可见精确 Project 名称；不能仅凭 URL 猜测项目归属。

每一轮对话严格执行以下步骤：

```text
1. list_pages 检查已有 pageId
     ↓
2. [若失效] new_page(chatgptUrl) 恢复会话 / [若存活] select_page(pageId)
     ↓
3. take_snapshot(pageId) 刷新最新 DOM
     ↓
4. fill 一次性填入完整 Prompt → 新快照 → click 一次提交
     ↓
5. 等待流式回复完成（监测停止生成按钮消失或复制按钮出现）
     ↓
6. take_snapshot(pageId) 获取最终渲染树
     ↓
7. 提取最后一则 assistant/ChatGPT 回复块作为外部顾问意见
```

所有等待必须有界：单次页面生成或导航最多等待 30 秒。超时后只获取一次新快照判断当前状态；若没有明确进展，立即停止并报告。不得连续重复 `wait_for`，也不得使用 `curl`、`fetch` 或其他命令绕过浏览器流程做公网诊断。

---

## 4. 异常检测与熔断处置

### 4.1 登录拦截（Unauthenticated）
- **现象**：`take_snapshot` 发现未找到提示词输入框，而是存在 `"Log in"`, `"Sign up"`, `"登录"`, `"注册"` 按钮。
- **处置**：
  - 立即终止自动脚本。
  - 向用户汇报：“当前 ChatGPT 页面尚未登录，请在弹出的 Chrome 窗口中完成登录，登录完成后请告诉我继续。”
  - 严禁抓取 Cookie 或自动化输入密码。

### 4.2 人机挑战 / Cloudflare Turnstile
- **现象**：页面出现 `"Verify you are human"`, `"请确认您是真人"` 或长时间处于白屏/加载态。
- **处置**：
  - 提示用户：“检测到 ChatGPT 触发人机验证，请在浏览器中完成勾选。”
  - 待用户确认后再行推进。

### 4.3 连接中断或页面崩溃
- **现象**：MCP 调用返回 `target page not found` 或协议超时。
- **处置**：
  - 尝试使用保存的 `chatgptUrl` 通过 `new_page` 恢复一次。
  - 若依然失败，按铁律向用户明示：“ChatGPT Web 顾问服务暂时断开，本轮将由 Antigravity 独立分析处理”，严禁静默 fallback 到其他 API。

### 4.4 Connector / OAuth 明确错误
- **现象**：页面出现 Connector 创建失败、OAuth discovery 失败、授权失败或其他明确错误提示。
- **处置**：
  - 当 `connector.action == "reuse"` 时，严禁进入 Connector 创建或删除流程。
  - 当 `connector.action == "recreate"` 时，只有初始快照确认不存在精确同名 Connector，或唯一同名 Connector 已删除且新快照确认其卡片消失后，才可导航到包含 `create-connector=true` 的 URL；否则必须在提交前熔断。
  - 立即停止当前网页操作，不再点击、重填或重复提交。
  - 保存一次最新快照，并按 `workspace-connector.md` 仅运行一次有界的 `status --local-only`。
  - 向用户报告网页原始错误与 Bridge 的 `live` 结果，然后结束本轮。不得启动 curl、公网探测或循环修复。
  - 若错误不是配置页面错误，而是 Advisor 回复中的账户连接/工具鉴权失败，改按 `workspace-connector.md` 的单次 Connector 恢复流程处理；最多重试该逻辑 Prompt 一次。
