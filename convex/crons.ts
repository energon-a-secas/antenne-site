import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// The publish bridge's schedule (docs/plans/2026-09-15-antenne-desk.md
// section 6.1). reconcile moves every run that stalled (a dispatch nobody
// claimed, a claim with no push, a push not yet verified) and queues a run for
// approvals that came due with nothing active; checkLive marks committed
// stories live once the site serves them; sweep deletes aged rows.

const crons = cronJobs();

crons.interval("reconcile publish runs", { minutes: 10 }, internal.publish.reconcile, {});

crons.interval("mark committed stories live", { minutes: 10 }, internal.publish.checkLive, {});

// Rate rows past 31 days, access requests past 30, spiked drafts past 90 and
// finished runs past 30. draftEvents are kept.
crons.daily("sweep aged rows", { hourUTC: 4, minuteUTC: 41 }, internal.publish.sweep, {});

export default crons;
