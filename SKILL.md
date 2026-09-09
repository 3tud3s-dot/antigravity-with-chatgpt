---
name: antigravity-with-chatgpt
description: >-
  Enables ChatGPT Web Advisor mode within an Antigravity conversation. Use this skill when the user
  requests to enable the ChatGPT advisor, asks to route prompts to ChatGPT Web first, or mentions
  'antigravity-with-chatgpt'. Ensures every subsequent user prompt in the current conversation is consulted
  with ChatGPT Web via chrome-devtools MCP before Antigravity makes final decisions and responses.
---

# Antigravity with ChatGPT Web Advisor (V0)

本技能在当前 Antigravity conversation 中启用 **ChatGPT Web Advisor** 模式。

```text
User Prompt
     ↓
ChatGPT Web UI (via chrome-devtools MCP)
     ↓
GPT Advisor Reply
     ↓
Antigravity 读取回复
     ↓
Antigravity 综合思考 / 执行工具 / 回复用户
```

在此模式下：
1. 当前 Antigravity 会话与专属的 ChatGPT 网页会话建立 **1:1 独立绑定**。
2. 用户的每一条 Prompt 在 Antigravity 响应前，必须先发送给对应的 ChatGPT 网页会话获取外部建议。
3. **ChatGPT 是外部顾问，Antigravity 是主控者**：Antigravity 负责最终判断、调用本地工具或直接回复用户，不可机械照搬 GPT 回复。

---

## 1. 会话状态与 1:1 绑定规范

为了确保当前 Antigravity 会话与 ChatGPT 网页会话的严格独立隔离，必须遵循以下状态管理规则：

- **状态文件路径**：
  `<appDataDir>\brain\<conversation-id>\chatgpt_session.json`
  （其中 `<conversation-id>` 从当前系统的环境上下文提取，例如系统提示中的 `Conversation ID`）。
- **状态结构**：
  ```json
  {
    "enabled": true,
    "antigravityConversationId": "<current-conversation-id>",
    "chatgptPageId": 12345,
    "chatgptUrl": "https://chatgpt.com/c/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "updatedAt": "2026-09-10T00:00:00Z"
  }
  ```
- **隔离原则**：
  - 不同的 Antigravity conversation 必须创建并绑定不同的 ChatGPT conversation。
  - 严禁多个 Antigravity 会话共享同一个 ChatGPT 网页会话。

---

## 2. 首次激活链路（Initialization Phase）

当用户在当前会话中首次提及启用本技能，或状态文件不存在时，按序执行以下步骤：

### 步骤 2.1：新建独立 Chrome 页面
1. 调用 `chrome-devtools` MCP 工具：
   `call_mcp_tool(ServerName="chrome-devtools", ToolName="new_page", Arguments={"url": "https://chatgpt.com/"})`
2. **强制规则**：必须通过 `new_page` 新建页面，绝对不可复用或读取用户此前已经打开的其他标签页。
3. 记录返回的 `pageId`。

### 步骤 2.2：检查加载与登录状态
1. 调用 `take_snapshot(pageId)` 获取最新 a11y 树。
2. 检查页面是否已加载且处于登录状态：
   - **已登录标志**：快照中存在提示词输入框（如 `#prompt-textarea` 或含有“问点什么”/“Ask anything”等占位描述的输入元素）。
   - **未登录标志**：页面包含“登录 / Log in”或“注册 / Sign up”按钮，且无消息输入区域。
3. **未登录熔断处理**：
   - 立即停止自动化操作。
   - 明确提示用户：“请在打开的 Chrome 窗口中手动登录 ChatGPT 账号。登录完成后请回复我继续。”
   - **严禁**尝试代填密码、读取凭据、Cookie 或 Token。

### 步骤 2.3：自动发送内嵌初始化 Prompt
在新建的空白 ChatGPT 会话中，由 Skill 自动输入并发送以下固定初始化 Prompt（**仅在初始化时发送一次，后续轮次绝不重复**）：

> 你是 Antigravity 的外部顾问。接下来会收到用户发送给 Antigravity 的任务。请给出简洁的分析、建议和可执行步骤，并指出重要风险或遗漏。Antigravity 会读取你的回复并负责最终判断和执行。

- **操作细节**：
  1. 根据 `take_snapshot` 定位输入框的最新 `uid`。
  2. 调用 `type_text(pageId=..., text=..., submitKey="Enter")` 或在输入后调用 `click` 点击发送按钮。
  3. 等待 ChatGPT 回复流式结束（参见 [browser-protocol.md](./references/browser-protocol.md)）。

### 步骤 2.4：获取并持久化绑定会话 URL
1. 初始化 Prompt 发送并回复完成后，页面 URL 会自动更新为形如：
   `https://chatgpt.com/c/<unique-uuid>`
2. 调用 `list_pages` 或执行快照核验，提取该 `pageId` 当前对应的完整会话 URL。
3. 将 `enabled: true`、`chatgptPageId`、`chatgptUrl` 写入 `<appDataDir>\brain\<conversation-id>\chatgpt_session.json`。
4. 向用户确认：“ChatGPT Web Advisor 模式已就绪，并已绑定专属顾问会话。”（若用户该轮已有附带具体任务，则顺带进入下一阶段处理）。

---

## 3. 每轮多轮交互链路（Per-Turn Loop）

在技能启用后，**本会话后续收到的每一条用户任务/提示词**，必须严格遵循以下执行循环：

### 步骤 3.1：提取用户原始 Prompt
获取用户本次对话输入的原始需求文本。

### 步骤 3.2：定位/恢复绑定的 ChatGPT 页面
1. 读取本会话的 `chatgpt_session.json` 获取 `chatgptPageId` 与 `chatgptUrl`。
2. 调用 `list_pages` 确认该 `chatgptPageId` 是否仍然存活：
   - **存活**：调用 `select_page(pageId=chatgptPageId, bringToFront=false)`。
   - **已关闭/失效**：调用 `new_page(url=chatgptUrl)` 重新打开该会话，更新本地 `chatgptPageId`。

### 步骤 3.3：发送本轮 Prompt 到 ChatGPT Web
1. 每次操作前重新调用 `take_snapshot(pageId)` 获取实时 DOM 状态。
2. 找到输入框，将用户原始 Prompt 原样发送给 ChatGPT（第一版保持原样发送，不加冗长包装）。
3. 使用 `type_text(..., submitKey="Enter")` 或点击发送按钮提交。

### 步骤 3.4：等待生成完成并提取回复
1. 等待 ChatGPT 流式回复结束（停止流式按钮消失，界面重新回到可发送状态）。
2. 调用 `take_snapshot(pageId)`，定位最新的 Assistant 回复区域。
3. 提取完整的 GPT 回复文本。

### 步骤 3.5：Antigravity 综合研判与决策执行
1. 将 GPT 回复作为外部顾问意见：
   ```text
   [ChatGPT Advisor Input]
   <提取的 GPT 回复>
   ```
2. Antigravity 结合以下要素进行终审研判：
   - 用户的原始目标与约束；
   - ChatGPT Advisor 提供的思路、步骤与风险提示；
   - 当前工作区（Workspace）实际代码、文件现状；
   - Antigravity 自身的工具集与规则（如安全边界规则）。
3. 展开实际行动：执行代码修改、命令测试或向用户输出最终回答。
4. **禁止机械转发**：在最终给用户的输出中，给出 Antigravity 结合自身判断后的完整方案，必要时可注明已参考 ChatGPT 顾问的建议。

---

## 4. 浏览器操作与安全铁律

1. **SPA 动态 UID 刷新原则**：
   ChatGPT 是典型的 React SPA，每次交互（输入、发送、流式渲染）后 DOM 节点的 `uid` 均可能变化。**严禁缓存或跨步骤复用旧快照中的 `uid`**，每次交互必须“快照 -> 操作 -> 再次快照”。
2. **禁止静默 Fallback**：
   若 Chrome DevTools MCP 发生网络断开、超时或崩溃：
   - **严禁**私自调用 `read_url_content`、`search_web`、curl、requests 或 OpenAI API 伪造顾问回复。
   - 必须主动、明确告知用户：“ChatGPT 顾问会话异常（具体报错），本轮暂无法获取外部顾问意见，将由 Antigravity 独立分析处理。”
3. **安全与隐私沙箱**：
   - 仅限操作本技能新建的对应 `pageId`。
   - 严禁遍历或读取用户其他 Tab 的页面内容（包括 Gemini、Overleaf、个人网页等）。
   - 严禁尝试嗅探或读取 Cookie、Token、localStorage、sessionStorage。
   - 严禁点击进入用户左侧历史对话列表中的无关项目。

---

## 5. 详细交互协议参考

有关 ChatGPT Web DOM 的精准定位模式、等待流式完成的判定逻辑与异常诊断详情，请查阅：
[browser-protocol.md](./references/browser-protocol.md)
