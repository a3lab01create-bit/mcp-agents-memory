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
   node build/index.js
   ```

5. **Claude MCP**:
   ```bash
   claude mcp add mcp-agents-memory node /path/to/build/index.js
   ```


## Tools (v2.0)
All tools are prefixed with `memory_` to ensure clear intent when used in multi-agent environments.
- `memory_remember(subject_key, content, memory_type, source_type)`: Store persistent long-term memory.
- `memory_recall(subject_key, query, limit)`: Recall relevant long-term memories with human-readable formatting.
- `memory_log_task(title, task_type, owner_key, project_key)`: Create a new task record.
- `memory_complete_task(task_id, outcome_summary, success_score)`: Mark a task as completed.
- `memory_log_session(task_id, orchestrator_key, model_name, provider)`: Log the start of an AI session.
- `memory_complete_session(session_id, final_outcome, summary, token_usage)`: Log session completion.
- `memory_learn(task_type, learning_type, content)`: Store reusable learnings and heuristics.
- `memory_get_learnings(task_type, limit)`: Retrieve past learning patterns.
- `memory_get_subject(subject_key)`: Fetch detailed metadata about a subject in the ecosystem.

## License
MIT
