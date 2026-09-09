# Antigravity with ChatGPT

一个用于在 Antigravity 会话中启用 ChatGPT Web Advisor 模式的本地 Skill。启用后，Antigravity 可通过 Chrome DevTools MCP 将用户任务发送给专属的 ChatGPT 网页会话，并结合顾问回复完成最终判断与执行。

## 放置位置

将整个 Skill 目录放置在用户级 Gemini Skills 目录中：

```text
~/.gemini/config/skills/antigravity-with-chatgpt/
```

Windows 也可以表示为：

```text
%USERPROFILE%\.gemini\config\skills\antigravity-with-chatgpt\
```

目录至少应包含：

```text
antigravity-with-chatgpt/
├── SKILL.md
└── references/
    └── browser-protocol.md
```
