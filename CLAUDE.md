# Ralph Methodology for Claude Code

This project uses the **Ralph autonomous development methodology**. Ralph treats LLM context like memory - it cannot be freed, only rotated. State persists in files and git, not in conversation context.

## Quick Commands

- **`/performance`** - Run full Turso database analysis to check bot performance, shadow bots, quadrant data, and data collection health. Use this at the start of sessions or when discussing trading results.

## Before Every Action

**ALWAYS read these files first:**
1. `RALPH_TASK.md` - Your current task and completion criteria
2. `.ralph/guardrails.md` - Lessons from past failures (FOLLOW THESE)
3. `.ralph/progress.md` - What's been accomplished so far
4. `.ralph/errors.log` - Recent failures to avoid

## Working Protocol

### Task Execution
1. Find the next unchecked criterion in RALPH_TASK.md (look for `[ ]`)
2. Focus on ONE criterion at a time - complete it fully before moving on
3. Run tests after changes (check RALPH_TASK.md for test_command)
4. Mark completed: change `[ ]` to `[x]` in RALPH_TASK.md
5. Update `.ralph/progress.md` with what you accomplished
6. Commit your changes with descriptive message

### Git Protocol
Commit early and often:
- After completing each criterion: `git add -A && git commit -m "ralph: description"`
- Before any risky refactor: commit current state as checkpoint
- Your commits ARE your memory across sessions

### Completion Signals
- When ALL criteria show `[x]`: **"RALPH COMPLETE - all criteria satisfied"**
- If stuck 3+ times: **"RALPH GUTTER - need fresh context"**

## Learning from Failures

When something fails, add a Sign to `.ralph/guardrails.md`:

```markdown
### Sign: [Descriptive Name]
- **Trigger**: When this situation occurs
- **Instruction**: What to do instead
- **Added after**: What happened
```

## When to Suggest /performance

Proactively suggest running `/performance` when:
- Starting a new session (to check current bot status)
- User asks about bot results, PnL, or trading performance
- Discussing shadow bots or focus mode strategies
- Before making changes to bot configurations
- Debugging why bots aren't trading or logging data
- Analyzing which quadrants or strategies are working
