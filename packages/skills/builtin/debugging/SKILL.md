---
name: debugging
description: Systematic approach to diagnosing and fixing bugs in code
tags: [debug, fix, bug, error]
trigger: debug this issue
version: 1
author: system
allowed-tools: [read, grep, exec, edit]
---

# Debugging

## Steps
1. **Reproduce**: Understand the exact error message or unexpected behavior
2. **Locate**: Use `grep` to find relevant code paths related to the error
3. **Read**: Read the identified files to understand the logic
4. **Hypothesize**: Form 1-3 hypotheses about the root cause
5. **Test**: For each hypothesis, check the evidence:
   - Read relevant test files
   - Check git history for recent changes
   - Run specific tests with `exec`
6. **Fix**: Apply the minimal change that addresses the root cause
7. **Verify**: Run the affected tests to confirm the fix
8. **Regression check**: Run the broader test suite

## Anti-patterns to avoid
- Don't change code you don't understand
- Don't add workarounds without understanding the root cause
- Don't fix multiple bugs in one change
- Don't skip the verification step
