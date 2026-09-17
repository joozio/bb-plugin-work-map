# Data and actions

Work Map runs inside your BB instance. It has no independent analytics, telemetry, advertising, hosted backend or external API calls. Installing a BB plugin grants it the host's plugin capabilities; Work Map is not a security sandbox.

## Reads

- Tasks projects, folders, labels, task descriptions and metadata.
- Task attachments and comment provenance, including the contributing session identifier when recorded by Tasks.
- BB projects, session titles, pins, activity, unread state and bounded latest-response previews.

Task data refreshes while the view is visible. Failed refreshes retain the last loaded data and display an error.

## Storage

BB's plugin storage holds map preferences, seen-update timestamps, creation receipts and settlement recovery records. Settlement records include before/after task fields, which can contain task descriptions, and identifiers of archived sessions. Completed settlement records are bounded to 200 plus interrupted actions; creation receipts currently remain until plugin storage is removed.

The view also uses browser session storage to recover a newly created session whose task attachment is unfinished. BB's native composer owns draft prompts and attachments. Work Map does not export this data into its source repository or release package.

## Changes

Explicit actions can create or edit Tasks projects, create backlog tasks, connect sessions to tasks, pin or unpin sessions, create sessions through BB, change task status and descriptions, and archive or unarchive sessions. Project maintenance is also exposed through `bb work-map` commands.

Opening a successfully loaded session preview marks only the displayed successful result read. When an existing session's native chat is open, BB owns read tracking and Work Map stops acknowledging its hidden summary. The chat uses that session's existing permissions; opening it sends no message. Removing task focus can unpin attached pinned sessions; the view describes that effect. Hiding an area changes visibility in Overview only. Search and attention filters still reach its work.

Task settlement writes a summary, next step, lifecycle and native status, reviewer, waiting dependency, follow-up date and status reason into the task description while preserving its body and history. Existing owner and progress fields are preserved. Undo checks for intervening changes before restoring fields. BB's task updates do not support atomic conditional writes, so simultaneous external edits remain a limitation.

Archiving stops running work. Work Map refuses to archive a session with children or source forks because BB's archive operation can include them. Undo can reopen recorded sessions; it does not restart an agent or recreate a removed environment. Recording a review request does not contact the reviewer.

## Provider and host behavior

Submitting BB's native composer starts the selected provider. The prompt, attachments and task context included in that prompt are subject to BB and that provider's data handling. Work Map's lack of its own external services does not make provider sessions offline. Your BB hosting, remote access, backups and installed plugins also remain outside Work Map's control.
