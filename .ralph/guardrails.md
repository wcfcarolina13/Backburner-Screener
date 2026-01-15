# Ralph Guardrails (Signs)

> Lessons learned from past failures. READ THESE BEFORE ACTING.

## Core Signs

### Sign: Read Before Writing
- **Trigger**: Before modifying any file
- **Instruction**: Always read the existing file first to understand context
- **Added after**: Core principle

### Sign: Test After Changes
- **Trigger**: After any code change
- **Instruction**: Run tests to verify nothing broke
- **Added after**: Core principle

### Sign: Commit Checkpoints
- **Trigger**: Before risky changes
- **Instruction**: Commit current working state first
- **Added after**: Core principle

### Sign: One Task Focus
- **Trigger**: When context grows large
- **Instruction**: Focus on single criterion, complete it, commit, move on
- **Added after**: Core principle

### Sign: Update Progress
- **Trigger**: After completing any criterion
- **Instruction**: Update .ralph/progress.md AND check off the criterion in RALPH_TASK.md
- **Added after**: Core principle

---

## Learned Signs

### Sign: Double-Escape Quotes in Template Literals
- **Trigger**: When building HTML with onclick handlers inside a template literal (backticks)
- **Instruction**: Use `\\'` not `\'` for quotes inside onclick attributes. Single escape gets consumed by the template literal, leaving unescaped quotes in browser output.
- **Added after**: Iteration 2 - toggleGpFilter('watching') broke because `\'` became `'` in output, causing "Unexpected identifier" JS error

### Sign: Check for Duplicate HTML Tags
- **Trigger**: When editing large template literal HTML blocks (especially around section boundaries)
- **Instruction**: After editing, search for duplicate tags like `<script><script>` or `</div></div>`. These cause JavaScript parsing errors ("SyntaxError: Unexpected token '<'") and break functionality without obvious errors.
- **Added after**: Iteration 15 - GUI showed "Connecting..." forever because duplicate `<script>` tag at line 3301-3302 caused JS parsing failure

### Sign: Test SSE Endpoints After Changes
- **Trigger**: When modifying web-server.ts HTML generation or event broadcasting
- **Instruction**: Test the `/events` SSE endpoint with `curl -s -N "http://localhost:3000/events" | head -50` to verify JSON events are being sent correctly
- **Added after**: Iteration 15 - SSE connection appeared broken but was actually working; the client-side JS couldn't parse events due to HTML error

