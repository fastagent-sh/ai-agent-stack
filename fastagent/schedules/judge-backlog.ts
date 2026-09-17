import { defineSchedule } from "@fastagent-sh/fastagent";

/**
 * The backlog, one batch at a time.
 *
 * A cold start is thousands of judgements, and the first attempt at it was a shell loop outside the
 * repository. It had no idea what a failure meant: when the model's usage limit was reached it kept
 * calling for another 262 rounds, judging nothing for hours. A clock does not have that problem — a
 * turn that fails is simply a turn that fails, and the next slot tries again once the window has moved.
 *
 * This fires often and does nothing when the queue is empty, so it costs a tool call and no model work
 * on the ordinary days when there is no backlog.
 *
 * Every fifteen minutes, not every four: the model's usage limit is the binding constraint, not the
 * clock. Firing faster than the quota refills only writes failure records — a four-minute schedule
 * produced twelve consecutive "usage limit reached" turns in under an hour and judged nothing.
 */
export default defineSchedule({
  cron: "*/15 * * * *",
  tz: "Asia/Shanghai",
  prompt:
    "Backlog judging, following the curate-index skill. Call candidates with limit 25 and refresh " +
    "false. If nothing is unjudged, reply 'queue empty' and stop without using any other tool. " +
    "Otherwise read each candidate with repo-readme, then record every verdict in a single " +
    "record-verdict call including judgedDescription. Do not run refresh and do not commit. Reply with " +
    "three numbers only: judged, in-stack, still queued.",
});
