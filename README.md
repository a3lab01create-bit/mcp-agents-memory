# mcp-agents-memory

Multi-agent Shared Long-term Memory MCP Server. This server allows different AI models (Claude, Gemini, GPT) to share a common memory space, log tasks, and learn patterns over time.

## Tech Stack
- Node.js + TypeScript
- @modelcontextprotocol/sdk
- PostgreSQL (pg)
- Zod (Validation)
- ssh2 (SSH Tunneling Support)

## Features
- **Shared Memory**: Agents can `remember` and `recall` information.
- **Task Tracking**: Log and complete tasks to build a project history.
- **Learning**: Capture insights from tasks to improve future performance.
- **SSH Tunneling**: Securely connect to remote databases.

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Run Setup Wizard**:
   ```bash
   npm run setup
   ```
   Follow the prompts to configure your DB connection and initialize the schema.

3. **Build and Start**:
   ```bash
   npm run build
   ```

4. **Run with your MCP Client**:
   ```bash
   npx @modelcontextprotocol/server-cli @modelcontextprotocol/server-stdio mcp-agents-memory
   ```

5. **Claude MCP**:
   ```bash
   claude mcp add mcp-agents-memory node /path/to/build/index.js
   ```


## Tools
- `remember(subject_key, content, memory_type, scope)`
- `recall(subject_key, query, limit)`
- `log_task(title, task_type, owner_key, project_key)`
- `complete_task(task_id, outcome, success_score)`
- `log_session(task_id, orchestrator_key, model_name, provider)`
- `learn(task_id, task_type, learning_type, content)`
- `get_learnings(task_type, limit)`
- `get_subject(subject_key)`

## License
MIT
