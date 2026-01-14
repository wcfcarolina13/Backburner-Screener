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

