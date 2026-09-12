# Development Instructions

## Project boundaries

- The only project that may be modified is:
  `C:\Users\qdtrr\.gemini\config\skills\antigravity-with-chatgpt`
- The reference project is:
  `D:\projects\codex-with-chatgpt`
- Treat the reference project as strictly read-only. Do not edit, format, generate files in, install dependencies in, commit from, or otherwise mutate it.
- Use the reference project only to understand relevant concepts and design tradeoffs. Do not copy it wholesale or attempt to turn this project into the same system.

## Development approach

- Work on one clearly defined feature at a time: discuss it, understand its constraints, design the smallest suitable change, implement it, and verify it before moving to another feature.
- Before changing anything, read and understand the existing V0 files and trace the current workflow affected by the requested change.
- Preserve the already validated primary flow unless the user explicitly asks to change it:

  ```text
  Antigravity → Chrome DevTools MCP → ChatGPT Web → GPT Advisor → Antigravity
  ```

- Antigravity remains the execution owner and final decision-maker. ChatGPT Web remains an external advisor.
- Prefer small, local changes that keep the working V0 behavior intact.
- Do not perform broad refactors, architectural rewrites, or unrelated cleanup without an explicit request.
- Do not import components, dependencies, protocols, or directory structures from the reference project merely because they exist there. Adopt an idea only when it directly supports the single feature currently being discussed.

## Change and verification discipline

- Modify only files required by the current feature and preserve unrelated behavior.
- After every modification, inspect `git status` and the complete relevant diff before reporting completion.
- After the diff is reviewed, ask the user to participate in testing the change through Antigravity in the actual Antigravity + Chrome DevTools MCP + ChatGPT Web environment. Do not treat this real test as a fully autonomous step or as complete without the user's confirmation.
- Do not claim end-to-end success based only on static inspection or assumptions about browser behavior.
- Do not automatically commit or push. Commit and push only when the user explicitly authorizes them.

## Workspace Connector lifecycle

- Maintain at most one active `Antigravity with ChatGPT · <workspace-name>` Connector for each canonical local workspace. A Connector is workspace-scoped, not conversation-scoped or feature-scoped.
- On every activation, detect and reuse the existing matching workspace Connector. A new Antigravity conversation may create a new ChatGPT conversation inside the shared workspace Project, but it must not create another Connector.
- Adding Skill features or starting another conversation is not a reason to create a replacement Connector.
- If the existing Connector endpoint changes, prefer updating that Connector in place when ChatGPT supports it. If it cannot be updated or safely reused, stop and report the exact problem; do not create a duplicate or delete/recreate the Connector without the user's explicit approval.
- Never modify, replace, or delete unrelated Connectors, especially any Connector whose name does not begin with `Antigravity with ChatGPT ·`.
