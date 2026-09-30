/** Tasks' system history records status transitions; ordinary edits do not. */
export function currentStatusSince(
  status: string,
  comments: readonly { kind: string; body?: string; createdAt: string }[],
): string | undefined {
  let incomplete = false;
  const events = comments
    .flatMap((comment) => {
      if (comment.kind !== "system") return [];
      const match = comment.body?.match(
        /^Status changed to (Backlog|Todo|In Progress|In Review|Done|Canceled)(?= by | ·|$)/i,
      );
      const at = Date.parse(comment.createdAt);
      if (
        comment.body?.startsWith("Status changed to ") &&
        (!match || !Number.isFinite(at))
      )
        incomplete = true;
      return match && Number.isFinite(at)
        ? [{ status: match[1].toLowerCase().replaceAll(" ", "_"), at }]
        : [];
    })
    .sort((a, b) => b.at - a.at);
  if (incomplete || !events.length || events[0].status !== status)
    return undefined;
  if (
    events.some(
      (event, index) =>
        index > 0 &&
        event.at === events[index - 1].at &&
        event.status !== events[index - 1].status,
    )
  )
    return undefined;
  // A redundant same-status event does not restart an existing review.
  let since = events[0].at;
  for (const event of events.slice(1)) {
    if (event.status !== status) break;
    since = event.at;
  }
  return new Date(since).toISOString();
}
