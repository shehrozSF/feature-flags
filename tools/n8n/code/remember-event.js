// n8n Code node "Remember event" in workflows/flag-change-to-discord.json (ADR 0040).
// The workflow holds an exact copy of this file; code.test.mjs fails if they differ.
// Runs after Discord accepted the post: records the event id, so a retry after a
// lost answer, or a replayed request, is answered 200 without posting again. Only
// after success: remembering earlier would turn the API's retry of a failed post
// into a "duplicate", and the event would be lost.

/** Enough for a burst of changes; the 5-minute signature window bounds replays anyway. */
const KEEP = 200;

/** The ids with `id` added once, newest last, at most KEEP. */
function remember(posted, id) {
  return [...posted.filter((x) => x !== id), id].slice(-KEEP);
}

if (typeof $input !== 'undefined') {
  // Workflow static data persists between production executions of this workflow.
  const store = $getWorkflowStaticData('global');
  const id = $('Verify and format').first().json.eventId;
  store.posted = remember(store.posted || [], id);
  return [{ json: { remembered: id } }];
}
