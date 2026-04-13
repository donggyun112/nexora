---
name: code-review
description: Review code for correctness, security, performance, and maintainability
tags: [code, review, quality, security]
trigger: review this code
version: 1
author: system
---

# Code Review

## Prerequisites
- Access to `read` and `grep` tools

## Steps
1. Read the file(s) to review using the `read` tool
2. Identify the purpose and context of the code
3. Check for **correctness** issues:
   - Logic errors, off-by-one, null/undefined access
   - Missing error handling at system boundaries
   - Race conditions in async code
4. Check for **security** issues:
   - Input validation (OWASP Top 10)
   - SQL injection, XSS, command injection
   - Secrets in code, hardcoded credentials
   - Path traversal, symlink attacks
5. Check for **performance** issues:
   - N+1 queries, unnecessary allocations
   - Missing pagination, unbounded loops
   - Memory leaks (unclosed handles, growing collections)
6. Check for **maintainability**:
   - Clear naming, single responsibility
   - Unnecessary complexity or premature abstraction
   - Missing types or unsafe casts
7. Provide actionable feedback with file paths and line numbers
8. Rate severity: critical > warning > suggestion

## Output Format
For each issue found:
- **[severity]** file:line — description + suggested fix
