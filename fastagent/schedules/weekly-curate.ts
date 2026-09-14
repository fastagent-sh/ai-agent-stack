import { defineSchedule } from "@fastagent-sh/fastagent";

// The GitHub Action measures what is already listed; nothing there can judge a new project, because
// judging needs a model and the repository holds no model credentials. This is that half.
export default defineSchedule({
  cron: "0 8 * * 1",
  tz: "Asia/Shanghai",
  prompt:
    "Weekly curation, following the curate-index skill. Call candidates with refresh true, read each " +
    "one with repo-readme before deciding, record the verdicts, then run refresh. Write the result to " +
    "curation/<today>.md in the workspace: what you judged, what entered the index and under which " +
    "layer, what you rejected and why, and anything you would not decide alone. A scheduled turn has " +
    "no channel carrying a reply, so that file is the delivery. Do not edit generated files by hand, " +
    "and do not push; leave the commit for the owner to review.",
});
