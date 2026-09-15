"""Centralized AI prompt templates. Each is a format string taking a single {input} — the
caller-supplied text (or, for context-aware modes, a structured context block built by
ai.context.build_task_context). Content/style is intentionally unchanged from the original
inline dict — only the location moved."""

AI_PROMPTS = {

    "title": (
        "Write a clear engineering task title, max 8 words, no quotes, no period. "
        "Make it action-oriented and specific to the actual work. "
        "Prefer useful technical context such as API, query, cache, migration, deployment, bug, "
        "performance, security, or integration when relevant. "
        "Avoid vague titles like Fix issue, Update task, Investigate problem. "
        "Reply with ONLY the title.\n\n"
        "Task: {input}"
    ),

    "description": (
        "Write a concise engineering task description in 2-4 sentences, plain text, no markdown. "
        "Capture what needs to be done, the current problem or context, the expected outcome, "
        "and important constraints or scope when provided. "
        "Do not invent requirements or technical details that are not present. "
        "Be direct, specific, and practical, with no filler.\n\n"
        "Task: {input}"
    ),

    "labels": (
        "Suggest 1-4 relevant labels for this engineering task. "
        "Use lowercase, hyphenated labels such as backend-api, database, performance, devops, security, "
        "iot, frontend, bug, feature, refactor, integration. "
        "Choose labels based on the actual work, not generic project categories. "
        "Reply with ONLY a comma-separated list.\n\n"
        "Task: {input}"
    ),

    "standup": (
        "Write a concise daily standup update from the provided tasks. "
        "Use plain text and * bullets, with these sections only: Yesterday, Today, Blockers. "
        "Focus on actual progress, completed work, current work, decisions, dependencies, and blockers. "
        "Combine related tasks when useful. "
        "Do not repeat task titles unnecessarily. "
        "Skip empty sections and anything with no meaningful update. "
        "Keep the update natural and suitable for a senior software engineer. "
        "Max 12 lines, no corporate filler.\n\n"
        "Tasks:\n{input}"
    ),

    "summarize": (
        "Summarize this task in one sentence for a standup. "
        "State the actual work and outcome or next step. "
        "Keep useful technical context, remove background and filler. "
        "Reply with ONLY the sentence.\n\n"
        "Task: {input}"
    ),

    "comment_reframe": (
        "You are writing a Plane issue comment for an experienced software engineering team.\n\n"
        "Task context:\n{input}\n\n"
        "Rewrite the raw message as a clear, professional, natural English comment. "
        "Keep the user's intent, technical reasoning, recommendation, and ownership boundaries intact. "
        "Be polite but direct, collaborative, and practical. "
        "Write like an experienced engineer communicating with another engineer, not like corporate communication. "
        "Preserve API names, function names, database names, code references, metrics, and technical terminology. "
        "When recommending a solution, make the preferred approach clear and briefly explain why. "
        "When asking someone to investigate, make the request specific and actionable. "
        "When offering help, make it clear that they should first explore from their side and involve you when needed. "
        "When setting ownership or availability expectations, communicate them professionally without sounding dismissive. "
        "Do not introduce new requirements, assumptions, blame, passive-aggressive language, or unnecessary apologies. "
        "Do not over-explain simple points. "
        "Use commas instead of em dashes, never use em dashes. "
        "Keep the original tone and intent as much as possible. "
        "Max 5 sentences. "
        "Reply with ONLY the rewritten comment, no preamble, no quotes."
    ),

    "message_reframe": (
        "Rewrite the raw message as a concise, professional English message for a software engineering team. "
        "Keep the original intent, context, technical details, recommendation, and ownership expectations. "
        "Be polite, direct, natural, and collaborative. "
        "Make requests actionable and recommendations clear. "
        "Avoid corporate language, unnecessary apologies, blame, passive-aggressive wording, and filler. "
        "Preserve technical terms exactly where useful. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the rewritten message, no preamble, no quotes.\n\n"
        "Message: {input}"
    ),

    "email_reframe": (
        "Rewrite this as a professional engineering email. "
        "Keep the original intent and all important technical context. "
        "Structure it naturally so the request, context, recommendation, and next steps are easy to understand. "
        "Be concise, direct, polite, and practical. "
        "Do not sound corporate, robotic, overly formal, or AI-generated. "
        "Preserve technical names, metrics, APIs, systems, and code references. "
        "Do not invent facts or requirements. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the email body, no subject, no preamble, no quotes.\n\n"
        "Message: {input}"
    ),

    "review_comment": (
        "Rewrite this as a clear engineering code or architecture review comment. "
        "Identify the concern, explain the technical reason briefly, and suggest the preferred approach. "
        "Be constructive, specific, and respectful. "
        "Distinguish between a required fix and an optional improvement when the input implies that distinction. "
        "Do not create issues that are not supported by the input. "
        "Preserve technical terminology and code references. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the comment.\n\n"
        "Comment: {input}"
    ),

    "followup": (
        "Rewrite this as a concise engineering follow-up. "
        "Clearly state what needs to be checked, completed, or updated and why when useful. "
        "Keep the tone polite, direct, and collaborative. "
        "Avoid sounding like a management reminder. "
        "Do not add urgency unless the original message indicates it. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the message.\n\n"
        "Message: {input}"
    ),

    "decision": (
        "Rewrite this as a concise technical recommendation or engineering decision. "
        "Clearly state the preferred approach, the reasoning, and any important trade-off or follow-up. "
        "Separate immediate fixes from optional or later improvements when applicable. "
        "Be practical and confident without overstating certainty. "
        "Do not invent facts or requirements. "
        "Preserve technical terminology and constraints. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the rewritten message.\n\n"
        "Context: {input}"
    ),

    "investigation": (
        "Turn this into a concise technical investigation request. "
        "State what should be investigated, the current evidence or symptom, what should be checked first, "
        "and what outcome is expected. "
        "Prefer investigation and validation before proposing major architectural changes. "
        "Do not assume the root cause unless the input already establishes it. "
        "Be practical, direct, and collaborative. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the request.\n\n"
        "Issue: {input}"
    ),

    "root_cause": (
        "Analyze the provided issue and produce a concise root-cause investigation summary. "
        "Separate confirmed facts, likely causes, and unknowns. "
        "Prioritize the most probable technical causes and the checks that would validate them. "
        "Do not present assumptions as facts. "
        "Prefer existing code, query behavior, indexes, configuration, logs, and metrics before suggesting large redesigns. "
        "Reply in plain text with these sections only: "
        "Likely Cause, Evidence, Checks, Recommended Fix.\n\n"
        "Issue:\n{input}"
    ),

    "task_plan": (
        "Create a practical implementation plan for this engineering task. "
        "Break it into 3-7 ordered steps. "
        "Start with investigation or validation when the root cause is not confirmed. "
        "Keep the plan focused on the smallest safe change that solves the problem. "
        "Mention testing, monitoring, rollout, or rollback only when relevant. "
        "Do not over-engineer the solution and do not invent requirements. "
        "Use plain text with numbered steps only.\n\n"
        "Task:\n{input}"
    ),

    "next_step": (
        "Determine the most useful next engineering action from the provided context. "
        "Prefer the smallest concrete action that reduces uncertainty or moves the task forward. "
        "Do not suggest a large refactor when a query check, log check, reproduction, metric, index review, "
        "or targeted test can validate the issue first. "
        "Reply with ONLY the recommended next step.\n\n"
        "Context:\n{input}"
    ),

    "priority": (
        "Suggest the appropriate priority for this engineering task using only P1, P2, P3, or P4. "
        "Consider customer impact, production impact, security impact, service availability, data integrity, "
        "blocking dependencies, and urgency. "
        "Do not assign high priority only because something is technically difficult. "
        "Reply with ONLY the priority and nothing else.\n\n"
        "Task:\n{input}"
    ),

    "task_type": (
        "Classify this engineering item using only one of these types: Task, Review. "
        "Use Review when the main purpose is code, architecture, implementation, or technical review. "
        "Use Task for implementation, investigation, bug fixing, operational work, or other execution work. "
        "Reply with ONLY the type.\n\n"
        "Task:\n{input}"
    ),

    "progress_update": (
        "Rewrite this into a concise engineering progress update. "
        "State what was done, what was found, what remains, and any blocker only when relevant. "
        "Focus on actual progress rather than repeating the task description. "
        "Keep it natural, professional, and direct. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the update.\n\n"
        "Context:\n{input}"
    ),

    "blocker": (
        "Rewrite this as a concise engineering blocker. "
        "Clearly state what is blocked, why it is blocked, what is needed to unblock it, "
        "and any dependency or owner mentioned in the input. "
        "Do not exaggerate urgency or blame anyone. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the blocker.\n\n"
        "Context:\n{input}"
    ),

    "release_note": (
        "Write a concise internal engineering release note from this task. "
        "Mention what changed, why it changed, and any important operational or user impact. "
        "Focus on the actual change and avoid marketing language. "
        "Do not invent metrics or outcomes. "
        "Reply with ONLY the release note.\n\n"
        "Task:\n{input}"
    ),

    "daily_summary": (
        "Create a concise daily engineering summary from the provided task/activity data. "
        "Highlight completed work, active work, blockers, overdue items, and notable changes. "
        "Prioritize meaningful changes over routine activity. "
        "Avoid repeating the same task across multiple sections. "
        "Use plain text with these sections only: Completed, In Progress, Blocked, Attention. "
        "Skip empty sections. "
        "Max 15 lines.\n\n"
        "Activity:\n{input}"
    ),

    "weekly_summary": (
        "Create a concise weekly engineering summary from the provided task and activity data. "
        "Focus on outcomes, completed work, major progress, blockers, overdue items, and important carry-over work. "
        "Group related work where useful. "
        "Do not simply list every task. "
        "Separate completed outcomes from ongoing work and risks. "
        "Use plain text with these sections only: Completed, Ongoing, Blockers, Carry Over. "
        "Skip empty sections. "
        "Max 20 lines.\n\n"
        "Activity:\n{input}"
    ),

    "task_cleanup": (
        "Review the provided task text and identify unnecessary duplication, ambiguity, missing context, "
        "or unclear ownership. "
        "Suggest only practical improvements that make the task easier to execute or track. "
        "Do not rewrite unnecessarily when the task is already clear. "
        "Reply with concise plain text.\n\n"
        "Task:\n{input}"
    ),

    "acceptance_criteria": (
        "Create 3-6 concise acceptance criteria for this engineering task. "
        "Make each criterion testable and specific. "
        "Cover expected behavior, important edge cases, and failure behavior when relevant. "
        "Do not invent product requirements not present in the task. "
        "Use plain text with - bullets only.\n\n"
        "Task:\n{input}"
    ),

    "duplicate_check": (
        "Determine whether the provided tasks appear to describe the same or substantially overlapping work. "
        "Consider title, problem, scope, API, component, and expected outcome. "
        "Reply with ONLY one of: Duplicate, Related, Separate. "
        "Then add one concise reason after a comma.\n\n"
        "Tasks:\n{input}"
    ),

    "smart_rewrite": (
        "Rewrite this message using the most appropriate professional engineering communication style. "
        "First understand the intent, whether it is a request, recommendation, follow-up, explanation, "
        "status update, blocker, review comment, or technical decision, then rewrite accordingly. "
        "Keep the original intent and technical meaning unchanged. "
        "Be concise, polite, direct, natural, and collaborative. "
        "Preserve technical terms and important details. "
        "Do not invent facts, requirements, or commitments. "
        "Avoid corporate filler, blame, passive-aggressive wording, and unnecessary apologies. "
        "Use commas instead of em dashes, never use em dashes. "
        "Reply with ONLY the rewritten message.\n\n"
        "Message:\n{input}"
    ),

}
