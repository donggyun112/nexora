---
name: deep-research
description: Conduct thorough research on a topic using web search and source analysis
tags: [research, search, analysis]
trigger: research this topic
version: 1
author: system
allowed-tools: [web-search, read, grep, knowledge]
---

# Deep Research

## Steps
1. Break the research question into 3-5 sub-questions
2. For each sub-question:
   a. Search for authoritative sources using `web-search`
   b. Read and extract key findings
   c. Cross-reference across multiple sources
3. Synthesize findings into a structured report
4. Identify gaps, contradictions, and areas needing further investigation
5. Save key findings to knowledge store for future reference

## Output Format
- Executive summary (2-3 sentences)
- Key findings (bulleted, with source attribution)
- Contradictions or uncertainties
- Recommendations for follow-up
