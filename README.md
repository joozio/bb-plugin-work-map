# Work Map

An interactive attention map inside BB. Open **Work Map** in the sidebar, or `/plugins/work-map/map`.

This package is distributed from Git. The npm `private` flag prevents accidental npm publication; BB can build the source during a Git installation.

Install from the public release:

```sh
bb plugin install 'git:https://github.com/joozio/bb-plugin-work-map.git@^0.1.0'
```

After installation, `bb plugin update work-map` checks for compatible releases.

Focus and activity are independent. Pinned sessions stay prominent even when idle. A green top bar means an agent is working; a coral ring and larger type mean focus. Successful unread responses use a filled blue **Ready to read** badge with a message icon; unread session and task cards also have a blue edge and light tint. They are notifications, not an inferred request for review. **Waiting for you** includes explicit input requests, failed runs, tasks in Review and due follow-ups. **Ready to read** is a separate filter and includes a review task when it also has an unread attached response.

Input requests have the strongest amber badge, failed runs have an error accent, and **Needs review** uses a restrained amber outline. Project containers keep neutral fills and gain a restrained blue border when they contain unread results, with specific counts such as **2 need review · 1 ready to read**; the child task carries the emphasis. Reading a successful result clears only that unread cue. It does not complete a task or remove its Review state. Focus and a running-agent bar can coexist with either kind of attention.

The overview arranges work around a central priority, with running agents nearby and quieter items around the edges. It shows up to 10 areas and sessions in smaller windows, or 13 when the map has at least 1100 pixels of space. Projects show up to four tasks, or six when focused. Click a project to see the rest.

Click a task, session or project to expand where it sits. Neighboring areas shrink to make room, retaining their status colors and showing an overflow count for hidden tasks. A short transition follows the change; reduced motion skips it. The arrangement stays stable while you explore. Projects reveal all open or unreviewed tasks; a task can expand further inside its project. Click again or use Collapse to shrink it. Escape steps from task details to the project, then back to the overview. **Open in side pane** is an explicit option, with **Expand in map** to return. Details link to the native task and full BB session, including split view. A successfully loaded session preview marks only the displayed result read; task review remains open until the task itself changes. Errors require an explicit acknowledgment in the summary view.

Session connections follow current task attachments, including links added after a session started. Attached sessions appear within their tasks. Task comments with a recorded agent session provide a separate **Commented on task** connection, visible in both directions. Comment history does not transfer activity or focus to a task. Archived attachments remain accessible and are labeled. A create or update without an attachment or recorded comment does not identify its originating session in BB, so Work Map cannot infer that connection.

Drag an item into the focus drop target, or use the preview's focus button. Session focus uses native BB pins. Direct task and project focus choices use plugin storage. Tasks also inherit focus from pinned attached sessions; removing a task's focus unpins those sessions in BB. The preview explains this before the action. A focused child keeps its project prominent. Search reaches tasks and sessions beyond the overview. Filters and Show all expose overflow, including additional attention items.

Ranking favors focus and explicit input requests or failures, then unread successful results ahead of routine review/follow-up queues and active agents. A review with a new attached result receives an additional lift. The overview reserves up to two result areas alongside the running agents. Older unread results share the remaining queue space, preserving some quiet work when space allows. The newest result sits near the center; additional results stay in the side columns instead of the outer bands. Zooming out adds older results farther down those columns while preserving the current center. While an area is expanded, positions stay fixed and badges update in place; collapse allows the new ranking to take effect. Urgency, dates, priority and recent changes refine that order. Planning dates are labeled as plans. Backlog dates do not create urgency. Task updates in the last 48 hours show an Updated marker until previewed. Inactive items rotate every 45 seconds when the pointer and keyboard focus are outside the map; rotation pauses during preview, search, filtering and dragging. A button disables rotation, and reduced motion starts with rotation paused. Important items do not rotate out.

Work Map reads and stores data in your BB instance. Tasks, attachments and comment provenance come from the Tasks plugin RPC. Session state comes from BB's live sidebar hook. Session previews are bounded excerpts of BB's latest response, not generated summaries. Expanded previews use BB's native Markdown renderer for tables, lists, links and code. Wide content scrolls within the preview; map cards show short plain-text excerpts or table headings. Responses longer than 6,000 characters show a shortened-response note and retain the full-session link. The cutoff can fall within a table or code block. Task data and attachments refresh every minute while the page is visible; response excerpts refresh every 30 seconds. Comment history for unchanged closed tasks is cached for up to five minutes. Refresh map bypasses both caches. A failed task refresh retains the previous data with an error banner. Missing connection data is reported. If a session preview fails, its card retains the session context; expanded details show the error and a Retry preview button.

Filters, search and Show all use a ranked single-column list. A clicked row expands beneath its heading without changing columns. The order stays fixed while details are open, including in the optional pane. If reading changes an item's status, it stays visible with a note until collapse. Closing reconciles the list and returns keyboard focus to the item or its nearest remaining neighbor.

**New session** opens BB's native composer inside Work Map. The toolbar starts a standalone session; the button in an expanded task or project starts there with editable context. Task sessions attach through Tasks as soon as BB creates them. Project sessions use the project's linked BB project as the initial selection, without attaching to an arbitrary task. You can change the project, environment, model and permissions before submitting. No agent starts until you submit. Drafts persist per task, project or standalone composer when closed.

After starting, the native live chat replaces the composer in the same area. Messages scroll inside a bounded chat frame, keeping the reply composer and its controls inside the session card. **Open full session** opens the normal BB session. Escape or **Collapse session** returns to the area. If task attachment fails, the session remains usable and **Retry attachment** repairs the link without starting another agent. Work Map stores creation receipts containing request, thread and task identifiers for retries; prompts and attachments remain in BB's native draft and session stores.

Existing sessions have **Chat here** in their expanded details. It opens BB's native live chat in the same area, with streaming, replies, queue/steer/stop controls and pending input requests supported by that session's provider. For a task with several sessions, choose the connected session first. **Back to summary**, Escape or re-clicking the expanded item returns to its short preview before collapsing the task or project. The optional side pane can also host the chat. Opening chat creates no session and sends no message; the native composer uses the existing session's permissions and draft store. BB owns read tracking while live chat is open. Archived or unavailable sessions retain the full-session link. The chat scrolls within a bounded area and stays at normal size through map zoom.

Expanded tasks put the status and next step first, followed by compact metadata and session choices. The expanded header drops its repeated excerpt. **New session** lives with the sessions; **Chat here** is the primary action for a selected active session. Pane, focus and task links stay in a quiet utility row.

The compact task action row follows the session content. **Pause here** and **Ready for review** reveal only the fields needed for that action, then **Save and pause** or **Save review** applies it. Cancel or Escape from a text field closes the form without saving and returns focus to its button. Escape in the reviewer dropdown only closes that dropdown. **Task done** remains one click and ignores unsaved handoff edits. Pause preserves the task status and its reason; review by **Me** moves it to Review. Review by **Someone else** needs a name and follow-up date, keeps the task open with a waiting label, and brings it back to Waiting for you when that date arrives. This records the handoff without contacting the reviewer. Task done completes the task. Existing due dates, priority, resources and description history are preserved; the current STATE and lifecycle fields describe the user's action. Tasks records these as user changes.

The checked **Archive viewed session** option affects only the attached session being viewed. Uncheck it to leave that session open. Standalone sessions have **Archive session**, also available below newly created chats. Archiving stops running work. Other attached sessions keep their state. BB's archive method includes child sessions and forks, so Work Map keeps a session with children or source forks open and explains why. The task action can still succeed. BB has no atomic archive-only-this-session operation, so this guard is checked immediately before calling archive.

Successful actions contract the expanded area and appear in **Settled today**, with **Undo**. Pause and review keep the task on the map; closed tasks remain in project history, and any ongoing attached session stays visible. Undo restores the changed task fields and reopens archived sessions. It refuses to overwrite newer task content and does not restart agents, recreate a cleaned environment, or erase Tasks' audit history. Partial failures say which part remains; Undo can restore the completed part. Private recovery receipts store the before/after task fields and archived session identifiers, retaining up to 200 completed receipts plus interrupted actions. Settled today checks the newest 200 receipt keys; older interrupted receipts remain stored but do not appear or reconcile automatically there. Tasks does not support atomic conditional writes; Work Map re-reads before a change, checks the result, and checks owned fields before Undo.

Existing lifecycle blocks keep their owner, progress evidence and date provenance. Older tasks without those fields still need classification by the task's owner or their workflow; a settlement does not infer missing ownership or evidence. Their assessment may report missing lifecycle fields instead of unclassified, without making them eligible for autonomous work.

Zoom ranges from 60% to 160%, using the toolbar buttons, slider, trackpad pinch or Ctrl/Command + wheel over the map. Ordinary scrolling stays unchanged. With a map tile focused, Ctrl/Command with `+`, `-` or `0` zooms or resets. Zooming in narrows the Overview and reveals longer excerpts and status detail around the pointer or inspected item. Zooming out removes excerpts gradually, adds outer areas up to 32, and shows more tasks per collapsed project. Titles and status labels retain a readable minimum size. Focus rings, activity bars and attention colors remain visible.

100% restores the original map density and is a snap point, with a short hold when a gesture crosses it. A small **100% ↺** button appears away from actual size. Reset keeps the current inspection open. Away from 100%, the item under the pointer remains included; scroll compensation keeps the same point in view where the scroll boundaries allow it. While an area is expanded, its root membership and order stay fixed. Zoom changes the detail and project density around it. Native chat, composers, settlement controls and the optional pane stay at normal size. Rotation pauses away from 100%. Zoom never changes focus, acknowledges results, starts sessions or settles work.

Project areas have compact **+** and **⋯** controls. Add a backlog task, start a session, or connect an existing session through an open task. New tasks and connection pickers open inside the area. **New project** and **Edit project** let you choose a name, task prefix (at creation), color, folder and linked BB workspace. The project color is a small identity dot; focus, activity and attention retain their separate colors.

**Manage areas** opens an optional pane with every project, including empty and hidden ones. Empty areas stay out of Overview unless focused; creating or opening one reveals it for adding work. **Hide from Overview** changes a Work Map preference only. Search, attention filters, Show all and Manage areas still reach its work. Tasks remain open and agents keep running. Restore brings the area back. Tasks has no project archive or task-move endpoint, so Work Map does not label hiding as archiving or copy tasks between projects.

The UI and agent CLI use the same validated project operations. Project edits check the current metadata before writing, though Tasks has no atomic conditional update. Creation request ids prevent repeated submissions from duplicating confirmed work. A failed request whose outcome cannot be determined requires checking the project before starting a new creation. Local receipts retain request fingerprints and resulting identifiers/metadata, without a second copy of task descriptions. New tasks start in backlog with the supplied text; Work Map does not invent ownership, dates or progress evidence.

Commands:

```sh
bb work-map status --json
bb work-map project list --json
bb work-map project create --name "Launch" --prefix LAUNCH --folder "Work"
bb work-map project edit LAUNCH --name "Product launch" --color "#8796ab"
bb work-map project hide LAUNCH
bb work-map project restore LAUNCH
bb work-map task create --project LAUNCH --title "Prepare launch brief"
bb work-map attach LAUNCH-1 --thread thr_example
bb work-map project --help
npm test
npm run typecheck
bb plugin build
bb plugin install . --yes
bb plugin reload work-map
```

Requires BB 0.43 or later, Plugin SDK 0.4.87, and the built-in Tasks plugin. Work Map has no independent external services or background schedules. Sessions submitted through its native composer run through the provider you choose in BB. Disable or remove Work Map to undo installation; existing tasks, sessions and the other plugins remain intact.

See [PRIVACY.md](PRIVACY.md) for data access, storage and action details, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for vendored component notices.
