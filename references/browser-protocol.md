# ChatGPT Web Browser Interaction Protocol (`browser-protocol.md`)

本参考文档规定了 `antigravity-with-chatgpt` Skill 通过 `chrome-devtools` MCP 工具与真实 ChatGPT 网页版（Single Page Application）进行交互的底层指令规范、DOM 识别特征、等待完成逻辑及异常恢复策略。

---

## 1. 核心 MCP 工具映射速查

所有浏览器控制必须统一通过 `call_mcp_tool` 发送至 `ServerName="chrome-devtools"`：

| 工具名称 | 核心入参示例 | 用途说明 |
| :--- | :--- | :--- |
| `new_page` | `{"url": "https://chatgpt.com/"}` | 创建专属的新 Tab，返回 `pageId` |
| `list_pages` | `{}` | 列出所有页面，用于恢复会话或抓取跳转后的 `chatgpt.com/c/...` URL |
| `select_page` | `{"pageId": 12345, "bringToFront": false}` | 聚焦并选中目标页面上下文 |
| `take_snapshot`| `{"pageId": 12345}` | 获取当前页面的完整 a11y 树及元素动态 `uid` |
| `type_text` | `{"pageId": 12345, "text": "...", "submitKey": "Enter"}` | 向当前焦点或指定输入区域键入文本并提交 |
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
  先通过 `click(pageId, uid)` 聚焦该输入框，随后调用 `type_text(pageId, text, submitKey="Enter")` 发送。

### 2.2 提交按钮（Send Button）
- **类型/角色**：`button`
- **属性/标识**：
  - Accessible name 为 `"Send prompt"`, `"发送提示词"`, `"Send message"`
  - 或快照中邻近输入框末尾的箭头按钮
- **备用操作**：若 `submitKey="Enter"` 未触发发送（例如多行输入框换行），通过快照获取该按钮的 `uid` 并调用 `click(pageId, uid)`。

### 2.3 生成状态判定（Streaming Status）
- **流式生成中**：
  - 发送按钮变换为停止按钮（Accessible name 为 `"Stop streaming"`, `"停止生成"`, `"停止流式传输"`）。
- **生成完成标志**：
  - “停止生成”按钮消失。
  - 重新出现可用的发送按钮（或输入框恢复可编辑状态）。
  - 最新的回复下方出现工具栏按钮（如 `"Copy"`, `"复制"`, `"Good response"`, `"赞同"` 等）。

---

## 3. 标准多轮交互流水线

每一轮对话严格执行以下步骤：

```text
1. list_pages 检查已有 pageId
     ↓
2. [若失效] new_page(chatgptUrl) 恢复会话 / [若存活] select_page(pageId)
     ↓
3. take_snapshot(pageId) 刷新最新 DOM
     ↓
4. click 聚焦输入框 + type_text(..., submitKey="Enter") 发送 Prompt
     ↓
5. 等待流式回复完成（监测停止生成按钮消失或复制按钮出现）
     ↓
6. take_snapshot(pageId) 获取最终渲染树
     ↓
7. 提取最后一则 assistant/ChatGPT 回复块作为外部顾问意见
```

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
