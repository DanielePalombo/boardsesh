#!/usr/bin/env node
// Breaks a wedged deploy concurrency group. One script, two lanes (LANES below):
//
//   production-deploy      production-deploy.yml runs on main.
//   mobile-ota-production  mobile-ota-production.yml runs on every branch.
//
// Both workflows run under `cancel-in-progress: false`, which is right for a run
// that is actually executing. GitHub applies that protection to a run doing
// nothing too: a job parked in the `waiting` state on the Production
// environment gate holds the group exactly like a running one, forever (the
// environment approval timeout is 30 days).
//
// While production-deploy is held, every later push to main queues as
// `pending` and GitHub keeps only the newest one, so nothing ships. Worse, the
// wedge is silent: the parked run never fails, so `notify-failure` never fires
// and the Discord deploy channel stays quiet. That is how main went two days
// without reaching production in August 2026 — one run parked at the
// environment gate after a required-reviewer rule was removed mid-run, and
// nothing said so.
//
// The OTA lane wedged the same way in October 2026. Run 40105607795 (a
// release/next push) finished `publish`, then its notify-train-deployment job —
// a Discord post — sat at the Production gate for 27 hours. The lane is
// `queue: max`, so 40 later runs queued behind it, along with the daily stable
// OTA tick and production-deploy's promote-mobile-ota job, which take the same
// group. Nothing alerted.
//
// So this watchdog runs on a schedule and looks for a run that holds the group
// without making progress:
//
//   cancel  — the run has at least one parked job, no job executing, and has
//             not moved in `stallMinutes`. On production-deploy, also any run
//             that has held the group for six hours. A confirmed cancellation
//             releases the group so the queued run behind it starts
//             immediately. On production-deploy, detect-changes baselines off
//             the last SUCCESSFUL deploy, so the surviving run redeploys
//             everything the cancelled one would have.
//   alert   — production-deploy only: the run is genuinely executing and has
//             been going far longer than a deploy takes, but has not reached
//             the six-hour ceiling.
//   none    — healthy, already finished, or `pending` (queued behind the
//             group). A pending run is the thing we are trying to let through,
//             so it is never a target.
//
// If cancelling empties production-deploy's group and main still has not
// deployed, the watchdog dispatches a fresh run so the wedge ends in a shipped
// commit rather than an empty queue. It dispatches at most once per head SHA,
// so a gate that stays broken produces one retry and an alert, not a deploy
// loop. The OTA lane never dispatches: `queue: max` keeps every pending run, so
// the queue drains by itself once the group frees.

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepTimer } from 'node:timers/promises';

const scriptPath = fileURLToPath(import.meta.url);

const DEFAULT_STALL_MINUTES = 45;
const DEFAULT_RUNNING_ALERT_MINUTES = 150;
const DEFAULT_MAX_RUN_MINUTES = 360;
const CANCEL_GRACE_MS = 5 * 60_000;
const FORCE_CONFIRM_MS = 60_000;
const POLL_INTERVAL_MS = 15_000;
const WATCHDOG_BUDGET_MS = 8 * 60_000;

// Statuses that occupy the concurrency group. `pending` is deliberately absent:
// that is a run queued BEHIND the group, i.e. the run we are freeing.
const HOLDING_RUN_STATUSES = new Set(['waiting', 'queued', 'requested', 'in_progress']);

// Job statuses that mean "has not run any steps yet". `waiting` is the
// environment gate; `queued`/`requested`/`pending` are waiting on a runner.
const PARKED_JOB_STATUSES = new Set(['waiting', 'queued', 'requested', 'pending']);

// Discord copy for production-deploy, keyed by planWatchdogActions' followUp.
const FOLLOW_UP_LINES = {
  'queued-run-takes-over': 'A queued or active deploy remains; no replacement was dispatched.',
  redispatched: 'Dispatched a fresh deploy for the current main.',
  'head-already-deployed': 'Nothing is queued, but the current main already deployed successfully — no action needed.',
  // Both of these are decided AFTER the cancels run, so planWatchdogActions
  // never sets them — runCli does, once it knows what actually landed.
  'cancel-failed': 'No deploy was started: a cancel did not land, so the group may still be held. Retrying next tick.',
  'dispatch-deferred':
    'No replacement deploy was started: run history could not be read or dispatch failed. Retrying next tick.',
  // No @here: the webhook post sets allowed_mentions.parse=[], so a ping would
  // render as inert text and read as louder than it is.
  'needs-intervention':
    "🚨 **main is NOT deploying.** Nothing is queued and this commit's one retry is already spent. Start a deploy manually (`gh workflow run production-deploy.yml`) and check the Production environment gate.",
  none: '',
};

const OTA_FOLLOW_UP_LINES = {
  'queue-resumes':
    'Runs queued behind it keep their place (`queue: max`) and start on their own; nothing was re-dispatched.',
  'cancel-failed': 'A cancel did not land, so the lane may still be held. Retrying next tick.',
  none: '',
};

// What differs between the two lanes. Everything else — job-list pagination,
// the cancel/force-cancel ladder, verified completion, the eight-minute budget
// and the 30-second API timeouts — is shared.
const PRODUCTION_DEPLOY_LANE = Object.freeze({
  name: 'production-deploy',
  workflowFile: 'production-deploy.yml',
  // Only main deploys production.
  branch: 'main',
  // A job queued for a runner counts too: a `runs-on` label that never comes
  // online holds the group exactly like the environment gate does.
  parkedJobStatuses: PARKED_JOB_STATUSES,
  // A `waiting` run with no job list yet counts as parked; the six-hour
  // ceiling is the backstop if that reading is ever wrong.
  parkedWithoutJobs: true,
  stallMinutes: DEFAULT_STALL_MINUTES,
  runningAlertMinutes: DEFAULT_RUNNING_ALERT_MINUTES,
  maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
  redispatch: true,
  deliveryJobName: null,
  copy: {
    quiet: 'no stalled production deploy found',
    unwedged: '🧹 **Production deploy unwedged**',
    stillWedged: '⚠️ **Production deploy still wedged**',
    stillRunning: '⏳ **Production deploy still running**',
    recovery: '🔁 **Production deploy recovery**',
    checkGate: 'Check runner availability and Production environment protection rules if stalls repeat.',
    followUps: FOLLOW_UP_LINES,
    // The loudest line: an unknown follow-up must never read as a recovery.
    unknownFollowUp: 'needs-intervention',
  },
});

const MOBILE_OTA_LANE = Object.freeze({
  name: 'mobile-ota-production',
  workflowFile: 'mobile-ota-production.yml',
  // release/next pushes and dispatches on main or release/next all take the
  // same `mobile-ota-production` group, so every branch is in scope.
  branch: null,
  // Only the environment gate. A job queued for a runner clears on its own, and
  // cancelling it throws away that run's publish — for a per-platform
  // "Republish … after native build" dispatch, nothing re-sends it.
  parkedJobStatuses: new Set(['waiting']),
  // And only a job the watchdog can see. A run that just left a long
  // `queue: max` wait can read `waiting` before its jobs are listed, and with no
  // jobs its hold start falls back to the trigger time — hours ago. With no
  // age ceiling behind it, the run status alone must never authorise a cancel.
  parkedWithoutJobs: false,
  stallMinutes: DEFAULT_STALL_MINUTES,
  // No age limits, on purpose. Killing an executing publish part-way can leave
  // iOS published and Android not, or the production canary already unlocked
  // for a publish that never lands, and GitHub's own `timeout-minutes` (240 on
  // `publish`) already bounds every executing job in that workflow. The gap
  // GitHub leaves is the parked job, whose clock never starts — the idle rule
  // covers that. The run's age is also a poor signal in a `queue: max` lane: a
  // run can wait hours in the queue before it starts.
  runningAlertMinutes: null,
  maxRunMinutes: null,
  // `queue: max` keeps every pending run, so nothing needs re-dispatching.
  redispatch: false,
  // Jobs are created only once their `needs` finish, so a run parked at
  // `live-store-runtimes / resolve` has no publish job listed at all. The report
  // says outright whether this job succeeded, rather than leaving the operator
  // to infer it from the parked-job list.
  deliveryJobName: 'publish',
  copy: {
    quiet: 'no stalled mobile OTA run found',
    unwedged: '🧹 **Mobile OTA lane unwedged**',
    stillWedged: '⚠️ **Mobile OTA lane still wedged**',
    // Unreachable while runningAlertMinutes is null; kept so the copy reads
    // right if the lane ever gains an alert.
    stillRunning: '⏳ **Mobile OTA run still running**',
    checkGate: 'Check the Production environment protection rules if stalls repeat.',
    followUps: OTA_FOLLOW_UP_LINES,
    unknownFollowUp: 'cancel-failed',
  },
});

const LANES = Object.freeze({
  [PRODUCTION_DEPLOY_LANE.name]: PRODUCTION_DEPLOY_LANE,
  [MOBILE_OTA_LANE.name]: MOBILE_OTA_LANE,
});

// The classifyRun options a lane implies. cancelAndConfirm re-checks with the
// same rules, so a lane without an age ceiling never gains one mid-cancel.
function laneRules(lane) {
  return {
    stallMinutes: lane.stallMinutes,
    runningAlertMinutes: lane.runningAlertMinutes,
    maxRunMinutes: lane.maxRunMinutes,
    parkedJobStatuses: lane.parkedJobStatuses,
    parkedWithoutJobs: lane.parkedWithoutJobs,
  };
}

function isHoldingRun(run) {
  return HOLDING_RUN_STATUSES.has(run?.status ?? '');
}

// GitHub run IDs increase across dispatches. A completed cancellation remains
// evidence for recovery on later ticks, even after a post-cancel API failure.
function isLatestRunCancelled(runs) {
  const latestRun = runs.reduce(
    (latest, run) => (latest === null || Number(run.id) > Number(latest.id) ? run : latest),
    null,
  );
  return latestRun?.status === 'completed' && latestRun.conclusion === 'cancelled';
}

// When the run began holding the group. `run_started_at` alone is not that: for
// a run that queued behind the group it is the trigger time. On 2026-10-25 a
// mobile-ota-production dispatch created at 05:25 was released at 18:31 and
// still reported run_started_at 05:25 — measured from there, it was 13 hours
// old a minute into its publish. GitHub creates a run's jobs only once it
// leaves the queue, so the earliest job's created_at is the real start.
// Cancellation can add later jobs but never an earlier one, so it cannot move
// this forward. Only the current attempt's jobs count: a partial re-run lists
// the jobs it carried over from attempt 1 with their old created_at, and the
// max() keeps the re-run's own start if nothing else is readable.
function isCurrentAttemptJob(run, job) {
  return (
    !Number.isInteger(run?.run_attempt) || !Number.isInteger(job?.run_attempt) || job.run_attempt === run.run_attempt
  );
}

function holdStartMs(run, jobs) {
  const runStartMs = Date.parse(run?.run_started_at ?? run?.created_at ?? '');
  const jobCreatedTimes = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => isCurrentAttemptJob(run, job))
    .map((job) => Date.parse(job?.created_at ?? ''))
    .filter(Number.isFinite);
  const firstJobCreatedMs = jobCreatedTimes.length > 0 ? Math.min(...jobCreatedTimes) : Number.NaN;
  const startTimes = [runStartMs, firstJobCreatedMs].filter(Number.isFinite);
  return startTimes.length === 0 ? null : Math.max(...startTimes);
}

// Cancellation can change updated_at without any job making progress. Queued
// jobs also receive started_at before a runner exists, so ignore those stamps.
function idleMinutes(run, jobs, nowMs) {
  const progressTimes = [holdStartMs(run, jobs)];
  for (const job of jobs ?? []) {
    if (
      (job.status === 'completed' || job.status === 'in_progress') &&
      job.conclusion !== 'cancelled' &&
      job.conclusion !== 'skipped'
    ) {
      progressTimes.push(Date.parse(job.started_at ?? ''));
      progressTimes.push(Date.parse(job.completed_at ?? ''));
    }
  }
  const readableTimes = progressTimes.filter(Number.isFinite);
  return readableTimes.length === 0 ? null : (nowMs - Math.max(...readableTimes)) / 60_000;
}

function ageMinutes(run, jobs, nowMs) {
  const startMs = holdStartMs(run, jobs);
  return startMs === null ? null : (nowMs - startMs) / 60_000;
}

// "notify-train-deployment (waiting)" — which gate to look at, and on the OTA
// lane, which work the stopped run never did.
const PARKED_JOB_NAME_LIMIT = 3;

function describeParkedJobs(jobs, parkedJobStatuses) {
  const parkedJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => parkedJobStatuses.has(job?.status ?? ''));
  if (parkedJobs.length === 0) return '';
  const names = parkedJobs
    .slice(0, PARKED_JOB_NAME_LIMIT)
    .map((job) => `${String(job.name ?? 'unnamed job').replace(/[\r\n`]/g, ' ')} (${job.status})`);
  if (parkedJobs.length > PARKED_JOB_NAME_LIMIT) names.push(`+${parkedJobs.length - PARKED_JOB_NAME_LIMIT} more`);
  return `; parked: ${names.join(', ')}`;
}

// "1h 30m" reads better than "90m" in a Discord ping, and a two-day wedge as
// "2d 1h" rather than a five-digit minute count.
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const remainder = total % 60;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  }
  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}

// A run is parked when something is queued behind a gate and nothing is moving.
// Jobs that already completed do not make it unparked: run #1337 finished
// detect-changes and deploy-app-web, then sat on check-rollback for two days.
// Run 40105607795 finished publish, then sat on notify-train-deployment.
function isParked(run, jobs, parkedJobStatuses = PARKED_JOB_STATUSES, parkedWithoutJobs = true) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    // No job list (a `waiting` run often has none yet). The run status is then
    // the only signal, and `waiting` means the environment gate by definition —
    // on a lane that accepts that signal (see MOBILE_OTA_LANE for one that doesn't).
    return parkedWithoutJobs && run?.status === 'waiting';
  }
  const executing = jobs.some((job) => job?.status === 'in_progress');
  const parked = jobs.some((job) => parkedJobStatuses.has(job?.status ?? ''));
  return !executing && parked;
}

function classifyRun({
  run,
  jobs,
  nowMs,
  stallMinutes = DEFAULT_STALL_MINUTES,
  runningAlertMinutes = DEFAULT_RUNNING_ALERT_MINUTES,
  maxRunMinutes = DEFAULT_MAX_RUN_MINUTES,
  parkedJobStatuses = PARKED_JOB_STATUSES,
  parkedWithoutJobs = true,
}) {
  if (!isHoldingRun(run)) return { action: 'none', reason: `status=${run?.status ?? 'unknown'}` };

  const idle = idleMinutes(run, jobs, nowMs);
  const age = ageMinutes(run, jobs, nowMs);

  // A lane opts out of an age limit with null (see MOBILE_OTA_LANE). Checked
  // explicitly: `age >= null` is `age >= 0`, which would cancel everything.
  if (Number.isFinite(maxRunMinutes) && age !== null && age >= maxRunMinutes) {
    return {
      action: 'cancel',
      reason: `running for ${formatDuration(age)}, at the ${maxRunMinutes}m maximum`,
      ageMinutes: age,
    };
  }

  if (jobs !== null && isParked(run, jobs, parkedJobStatuses, parkedWithoutJobs)) {
    if (idle === null) return { action: 'none', reason: 'unreadable-timestamps' };
    if (idle < stallMinutes) {
      return { action: 'none', reason: `parked ${formatDuration(idle)}, under the ${stallMinutes}m threshold` };
    }
    return {
      action: 'cancel',
      reason: `parked for ${formatDuration(idle)} with no job executing (holding the concurrency group)${describeParkedJobs(jobs, parkedJobStatuses)}`,
      idleMinutes: idle,
    };
  }

  if (Number.isFinite(runningAlertMinutes) && age !== null && age > runningAlertMinutes) {
    return {
      action: 'alert',
      reason: `running for ${formatDuration(age)}, longer than the ${runningAlertMinutes}m alert threshold`,
      ageMinutes: age,
    };
  }

  return { action: 'none', reason: 'executing normally' };
}

// One watchdog run's worth of decisions. `runs` is the workflow's recent run
// list (newest first, as the API returns it); `jobsByRunId` maps a run id to its
// jobs, and may omit runs whose jobs we could not read.
function planWatchdogActions({ runs, jobsByRunId = {}, headSha = '', nowMs, lane = PRODUCTION_DEPLOY_LANE }) {
  const candidates = Array.isArray(runs) ? runs : [];
  const rules = laneRules(lane);
  const cancel = [];
  const alert = [];

  for (const run of candidates) {
    const jobs = jobsByRunId[String(run?.id ?? '')];
    const verdict = classifyRun({ run, jobs, nowMs, ...rules });
    if (verdict.action === 'cancel') cancel.push({ run, ...verdict, ...deliveryState(jobs, lane) });
    if (verdict.action === 'alert') alert.push({ run, ...verdict });
  }

  // The OTA lane is `queue: max`: every pending run keeps its place and starts
  // once the group frees, so there is no successor to check and nothing to
  // dispatch. The recovery rules below exist because production-deploy keeps
  // only ONE pending run and can end a wedge with an empty queue.
  if (!lane.redispatch) {
    return {
      cancel,
      alert,
      redispatch: false,
      followUp: cancel.length > 0 ? 'queue-resumes' : 'none',
      recoveringCancelledRun: false,
    };
  }

  const cancelledIds = new Set(cancel.map((entry) => String(entry.run.id)));
  const recoveringCancelledRun = isLatestRunCancelled(candidates);
  const recoveryNeeded = cancel.length > 0 || recoveringCancelledRun;
  // Anything still holding or queued after the cancels takes over the group, so
  // main ships without our help. `pending` counts here — it is the run we freed.
  const survivorHoldsGroup = candidates.some(
    (run) => !cancelledIds.has(String(run?.id ?? '')) && (isHoldingRun(run) || run?.status === 'pending'),
  );

  // A dispatch we already made for this SHA means the retry has been spent: if
  // that one wedged too, the gate is broken in a way cancelling cannot fix.
  //
  // This cannot tell our dispatch from an operator's own `gh workflow run
  // production-deploy.yml` on the same commit — production-deploy declares no
  // workflow_dispatch inputs, so there is no marker to set. Erring this way is
  // the safe direction: a manual dispatch for the SHA consumes the retry, so a
  // later stall on that commit is cancelled and reported rather than
  // re-dispatched. The operator who is already in the run's page is better
  // placed to decide than a loop is.
  const alreadyRetriedHead =
    headSha !== '' && candidates.some((run) => run?.event === 'workflow_dispatch' && run?.head_sha === headSha);

  const headAlreadyDeployed =
    headSha !== '' &&
    candidates.some((run) => run?.head_sha === headSha && run?.status === 'completed' && run?.conclusion === 'success');

  const redispatch =
    recoveryNeeded && !survivorHoldsGroup && !alreadyRetriedHead && !headAlreadyDeployed && headSha !== '';

  // What happens to main AFTER the cancels — the report is only worth anything
  // if it distinguishes these. Freeing the group and then saying "the queued run
  // takes over" when nothing is queued and the retry is spent would announce a
  // recovery while production sits idle, which is the exact failure this
  // watchdog exists to end.
  let followUp = 'none';
  if (recoveryNeeded) {
    if (survivorHoldsGroup) followUp = 'queued-run-takes-over';
    else if (redispatch) followUp = 'redispatched';
    else if (headAlreadyDeployed) followUp = 'head-already-deployed';
    else followUp = 'needs-intervention';
  }

  return { cancel, alert, redispatch, followUp, recoveringCancelledRun };
}

// Whether the lane's delivery job (OTA: `publish`) succeeded in a run being
// stopped. A cancel never retries it, so the report has to say.
function deliveryState(jobs, lane) {
  if (lane.deliveryJobName === null) return {};
  const deliverySucceeded =
    Array.isArray(jobs) &&
    jobs.some(
      (job) => job?.name === lane.deliveryJobName && job.status === 'completed' && job.conclusion === 'success',
    );
  return { deliverySucceeded };
}

function deliverySuffix(entry, lane) {
  if (typeof entry.deliverySucceeded !== 'boolean') return '';
  return `; ${lane.deliveryJobName} ${entry.deliverySucceeded ? 'succeeded' : 'did not succeed'}`;
}

// The Discord line under a stopped run on a lane with a delivery job.
function deliveryGuidance(entry, lane) {
  if (typeof entry.deliverySucceeded !== 'boolean') return null;
  return entry.deliverySucceeded
    ? `  \`${lane.deliveryJobName}\` had already succeeded; only the jobs after it were lost.`
    : `  \`${lane.deliveryJobName}\` did not succeed and is not retried: dispatch ${lane.workflowFile} again for this branch unless a later run there publishes the same platforms.`;
}

function shortSha(run) {
  return typeof run?.head_sha === 'string' ? run.head_sha.slice(0, 7) : 'unknown';
}

// A lane that spans branches names the branch, and the run title: on the OTA
// lane that is what tells a train push from a "Republish ios after native
// build" dispatch, whose publish nothing else re-sends. Titles come from the
// workflow's run-name; backticks and newlines are stripped so one cannot break
// the Discord formatting.
const RUN_TITLE_LIMIT = 80;

function runContext(run, lane) {
  if (lane.branch !== null) return '';
  const branch = String(run?.head_branch ?? 'unknown branch');
  const title = String(run?.display_title ?? '')
    .replace(/[\r\n`]/g, ' ')
    .trim()
    .slice(0, RUN_TITLE_LIMIT);
  return title === '' ? ` on ${branch}` : ` on ${branch}, "${title}"`;
}

function describeRun(entry, lane = PRODUCTION_DEPLOY_LANE) {
  const { run, reason } = entry;
  return `run #${run.run_number ?? run.id} (${shortSha(run)}${runContext(run, lane)}, status=${run.status}): ${reason}${deliverySuffix(entry, lane)}`;
}

function formatSummary(
  plan,
  { dryRun = false, failedCancelIds = new Set(), dispatched = plan.redispatch, lane = PRODUCTION_DEPLOY_LANE } = {},
) {
  const verb = dryRun ? 'would cancel' : 'stopped';
  const lines = [];
  for (const entry of plan.cancel) {
    const failed = failedCancelIds.has(String(entry.run.id));
    lines.push(`${failed ? 'could NOT cancel' : verb} ${describeRun(entry, lane)}`);
  }
  for (const entry of plan.alert) lines.push(`alerting on ${describeRun(entry, lane)}`);
  if (dispatched) {
    lines.push(
      dryRun ? 'would dispatch a fresh production deploy for main' : 'dispatched a fresh production deploy for main',
    );
  }
  if (plan.followUp === 'needs-intervention') {
    lines.push('main is NOT deploying: nothing is queued and this head sha has no retry left — needs a human');
  }
  if (lines.length === 0) lines.push(lane.copy.quiet);
  return lines.join('\n');
}

// Discord rejects a content field over 2000 characters with a 400, and the
// workflow's post is best-effort — so an oversized message would fail silently,
// which is the failure mode this whole watchdog exists to remove. Cap it and say
// the report was cut; the job summary always carries the full text.
const DISCORD_CONTENT_LIMIT = 2000;
const DISCORD_TRUNCATION_NOTICE = '\n… truncated — the job summary has the full list.';

function capDiscordContent(content) {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  return `${content.slice(0, DISCORD_CONTENT_LIMIT - DISCORD_TRUNCATION_NOTICE.length)}${DISCORD_TRUNCATION_NOTICE}`;
}

// Discord content. Mirrors the deploy notifications in production-deploy.yml:
// URLs wrapped in <…> so Discord drops the inline preview embed.
function formatDiscordContent(
  plan,
  { runUrlBase = '', failedCancelIds = new Set(), followUp = plan.followUp, lane = PRODUCTION_DEPLOY_LANE } = {},
) {
  const { copy } = lane;
  if (plan.cancel.length === 0 && plan.alert.length === 0) {
    // Report a recovery attempt without claiming this tick stopped a run.
    // Retry-spent ticks stay quiet rather than notifying every 15 minutes.
    if (plan.recoveringCancelledRun && (followUp === 'redispatched' || followUp === 'dispatch-deferred')) {
      return `${copy.recovery}\n${copy.followUps[followUp]}`;
    }
    return '';
  }

  const lines = [];
  if (plan.cancel.length > 0) {
    const cancelled = plan.cancel.filter((entry) => !failedCancelIds.has(String(entry.run.id)));
    const failed = plan.cancel.filter((entry) => failedCancelIds.has(String(entry.run.id)));

    // The headline follows the WORST outcome, not the best: if any cancel did
    // not land, a run may still be holding the group, and "unwedged" over a
    // still-wedged deploy is the reassuring-but-wrong reading this watchdog is
    // supposed to make impossible.
    lines.push(failed.length > 0 ? copy.stillWedged : copy.unwedged);
    for (const entry of cancelled) {
      lines.push(
        `• Stopped run #${entry.run.run_number ?? entry.run.id} (\`${shortSha(entry.run)}\`${runContext(entry.run, lane)}) — ${entry.reason}.`,
      );
      const guidance = deliveryGuidance(entry, lane);
      if (guidance !== null) lines.push(guidance);
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    // Reported, not omitted: a cancel that did not land may mean the run is
    // still holding the group, which is the one thing an operator needs to know.
    for (const entry of failed) {
      lines.push(
        `• Could NOT cancel run #${entry.run.run_number ?? entry.run.id} (\`${shortSha(entry.run)}\`${runContext(entry.run, lane)}) — it may still be holding the group. Retrying next tick.`,
      );
      if (runUrlBase !== '') lines.push(`  <${runUrlBase}/${entry.run.id}>`);
    }
    lines.push(copy.followUps[followUp] ?? copy.followUps[copy.unknownFollowUp]);
    lines.push(copy.checkGate);
  }
  for (const entry of plan.alert) {
    lines.push(
      `${copy.stillRunning} — run #${entry.run.run_number ?? entry.run.id} (\`${shortSha(entry.run)}\`${runContext(entry.run, lane)}), ${entry.reason}. Not cancelled.`,
    );
    if (runUrlBase !== '') lines.push(`<${runUrlBase}/${entry.run.id}>`);
  }
  return capDiscordContent(lines.join('\n'));
}

// A hung API call would give the watchdog the very failure it exists to break —
// a silent stall, here for the runner's 6-hour job timeout. Every call is bounded.
const GH_API_TIMEOUT_MS = 30_000;
const JOBS_PAGE_SIZE = 100;
const MAX_JOB_PAGES = 5;
const RUNS_PAGE_SIZE = 30;

// Statuses the runs API can filter on that mean "not finished". Queried
// individually so a run holding the group is found however deep the cancelled
// history above it has grown.
// `pending` is here for the survivor check rather than for cancelling — a run
// queued behind the group is never a target. If a future API drops it as a
// filter value, the per-status try/catch swallows the rejection and the recent
// unfiltered page still carries pending runs, so the check degrades rather than
// breaking.
const HOLDING_QUERY_STATUSES = Object.freeze(['waiting', 'queued', 'requested', 'in_progress', 'pending']);

// `branch: null` lists every branch (the OTA lane); the default keeps the
// production-deploy listing on main.
function createCliGitHub({ repository, workflowFile, branch = 'main', api, now = Date.now }) {
  const branchQuery = branch === null ? '' : `branch=${encodeURIComponent(branch)}&`;
  let deadlineMs = Infinity;
  const ghApi = (args) => {
    const remainingMs = deadlineMs - now();
    if (remainingMs <= 0) throw new Error('watchdog deadline exceeded');
    if (api) return api(args);
    return execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1, Math.min(GH_API_TIMEOUT_MS, remainingMs)),
    });
  };

  return {
    setDeadline(nextDeadlineMs) {
      deadlineMs = nextDeadlineMs;
    },
    // Two queries, unioned, because a single newest-first page is not enough.
    //
    // Every push that arrives while a run is parked replaces the one pending run
    // and leaves ANOTHER cancelled run in the history above the holder. The
    // August 2026 wedge stacked 17 of those in eight hours; a longer one buries
    // the parked run past any fixed page size, and the watchdog would go blind
    // exactly when it is needed. So the holding runs are fetched by status —
    // the server filters, and no amount of cancelled history can hide them.
    //
    // The recent page is still needed for the dispatch guards, which ask about
    // completed runs for the current head sha. Those are the newest runs by
    // definition: anything that could push them off the page is a run for a
    // NEWER commit, at which point this head is no longer main's head.
    listRuns() {
      const byId = new Map();
      const add = (runs) => {
        for (const run of runs) if (run?.id !== undefined) byId.set(String(run.id), run);
      };

      let statusQueriesOk = true;
      for (const status of HOLDING_QUERY_STATUSES) {
        try {
          add(this.listRunsByStatus(status));
        } catch {
          // Keep discovering candidates, but withhold redispatch on incomplete history.
          statusQueriesOk = false;
        }
      }
      // Isolated like the status queries — but its loss is not free. The
      // dispatch guards (alreadyRetriedHead, headAlreadyDeployed) read completed
      // runs, which only this page carries, so runCli withholds the dispatch
      // rather than firing one it cannot justify.
      let recentPageOk = statusQueriesOk;
      try {
        add(this.listRecentRuns());
      } catch {
        recentPageOk = false;
      }
      return { runs: [...byId.values()], recentPageOk };
    },
    listRunsByStatus(status) {
      const payload = ghApi([
        '--method',
        'GET',
        `repos/${repository}/actions/workflows/${workflowFile}/runs?${branchQuery}status=${status}&per_page=${RUNS_PAGE_SIZE}`,
      ]);
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    listRecentRuns() {
      const payload = ghApi([
        '--method',
        'GET',
        `repos/${repository}/actions/workflows/${workflowFile}/runs?${branchQuery}per_page=${RUNS_PAGE_SIZE}`,
      ]);
      const parsed = JSON.parse(payload);
      if (!Array.isArray(parsed?.workflow_runs)) throw new Error('unreadable workflow history');
      return parsed.workflow_runs;
    },
    // Paginated deliberately. A truncated job list is worse than no list: drop
    // the page holding the one `in_progress` job and isParked reads the run as
    // parked, which cancels a deploy that is actually working.
    listJobs(runId) {
      try {
        const jobs = [];
        for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
          const payload = ghApi([
            '--method',
            'GET',
            `repos/${repository}/actions/runs/${runId}/jobs?per_page=${JOBS_PAGE_SIZE}&page=${page}`,
          ]);
          const parsed = JSON.parse(payload);
          const pageJobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
          jobs.push(...pageJobs);
          const totalCount = parsed?.total_count;
          if (!Array.isArray(parsed?.jobs) || !Number.isInteger(totalCount) || totalCount < 0) return null;
          if (jobs.length >= totalCount) return jobs;
          if (pageJobs.length === 0) return null;
        }
        return null;
      } catch {
        // Unknown is distinct from a complete empty list. Idle cancellation
        // requires complete jobs; the absolute age ceiling still applies.
        return null;
      }
    },
    getHeadSha() {
      const reference = JSON.parse(ghApi(['--method', 'GET', `repos/${repository}/git/ref/heads/main`]));
      if (typeof reference?.object?.sha !== 'string' || reference.object.sha === '') {
        throw new Error('unreadable main head');
      }
      return reference.object.sha;
    },
    getRun(runId) {
      const run = JSON.parse(ghApi(['--method', 'GET', `repos/${repository}/actions/runs/${runId}`]));
      if (run?.id !== runId || typeof run.status !== 'string') throw new Error('unreadable workflow run');
      return run;
    },
    forceCancelRun(runId) {
      ghApi(['--method', 'POST', `repos/${repository}/actions/runs/${runId}/force-cancel`]);
    },
    cancelRun(runId) {
      ghApi(['--method', 'POST', `repos/${repository}/actions/runs/${runId}/cancel`]);
    },
    dispatchRun(ref) {
      ghApi([
        '--method',
        'POST',
        `repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
        '-f',
        `ref=${ref}`,
      ]);
    },
  };
}

// Both stages require observed completion: a 202 response only acknowledges
// the request. Recheck eligibility before force-cancelling an idle intervention,
// under the SAME lane rules that picked the target: re-checking an OTA run
// against production-deploy's six-hour ceiling would force-cancel a publish
// that resumed meanwhile.
async function cancelAndConfirm({
  github,
  runId,
  now = Date.now,
  sleep = sleepTimer,
  deadlineMs,
  rules = laneRules(PRODUCTION_DEPLOY_LANE),
}) {
  const requireTime = () => {
    if (now() >= deadlineMs) throw new Error('watchdog deadline exceeded');
  };
  requireTime();
  let run = github.getRun(runId);
  if (run.status === 'completed') return 'stopped';
  const jobs = github.listJobs(runId);
  if (classifyRun({ run, jobs, nowMs: now(), ...rules }).action !== 'cancel') {
    if (jobs === null) throw new Error('idle cancellation eligibility cannot be confirmed: job list unreadable');
    return 'resumed';
  }
  requireTime();
  try {
    github.cancelRun(runId);
  } catch (error) {
    requireTime();
    if (github.getRun(runId).status === 'completed') return 'stopped';
    // A previous ordinary cancellation may already be pending. A conflict
    // must not prevent escalation forever; other API errors remain failures.
    const conflict = /HTTP\s+409\b/.test(`${error.message}\n${error.stderr ?? ''}`);
    if (!conflict) throw error;
  }

  const waitForCompletion = async (durationMs) => {
    const stageDeadlineMs = Math.min(deadlineMs, now() + durationMs);
    while (true) {
      requireTime();
      run = github.getRun(runId);
      if (run.status === 'completed') return true;
      if (now() >= stageDeadlineMs) return false;
      await sleep(Math.min(POLL_INTERVAL_MS, stageDeadlineMs - now()));
    }
  };
  if (await waitForCompletion(CANCEL_GRACE_MS)) return 'stopped';

  requireTime();
  run = github.getRun(runId);
  if (run.status === 'completed') return 'stopped';
  const freshJobs = github.listJobs(runId);
  // Our cancel took the parked job down but the run never reached `completed`:
  // every job has finished, nothing executes, and the run still holds the
  // group. classifyRun reads that as "not parked", and on a lane with no age
  // ceiling nothing would ever end it. Force-cancelling it can stop nothing.
  const stuckAfterCancel =
    Array.isArray(freshJobs) && freshJobs.length > 0 && freshJobs.every((job) => job?.status === 'completed');
  if (!stuckAfterCancel && classifyRun({ run, jobs: freshJobs, nowMs: now(), ...rules }).action !== 'cancel') {
    if (freshJobs === null) throw new Error('could not read complete job list before force cancellation');
    return 'resumed';
  }
  requireTime();
  try {
    github.forceCancelRun(runId);
  } catch (error) {
    requireTime();
    if (github.getRun(runId).status === 'completed') return 'stopped';
    throw error;
  }
  if (await waitForCompletion(FORCE_CONFIRM_MS)) return 'stopped';
  throw new Error('force cancellation did not reach completed status');
}

async function runCli({
  github,
  lane = PRODUCTION_DEPLOY_LANE,
  headSha,
  nowMs,
  now = Date.now,
  sleep = sleepTimer,
  runUrlBase,
  discordFilePath,
  outputPath,
  dryRun,
}) {
  const logPrefix = `${lane.name}-watchdog:`;
  const rules = laneRules(lane);
  const deadlineMs = now() + WATCHDOG_BUDGET_MS;
  github.setDeadline?.(deadlineMs);
  const { runs, recentPageOk } = github.listRuns();
  const jobsByRunId = {};
  for (const run of runs) {
    if (isHoldingRun(run)) jobsByRunId[String(run.id)] = github.listJobs(run.id);
  }
  const plannedActions = planWatchdogActions({ runs, jobsByRunId, headSha, nowMs: nowMs ?? now(), lane });
  const failedCancelIds = new Set();
  const resumedIds = new Set();
  const hadCandidates = plannedActions.cancel.length > 0;
  for (const entry of plannedActions.cancel) {
    console.error(`${logPrefix} ${dryRun ? 'would cancel' : 'cancelling'} ${describeRun(entry, lane)}`);
    if (dryRun) continue;
    try {
      const result = await cancelAndConfirm({ github, runId: entry.run.id, now, sleep, deadlineMs, rules });
      if (result === 'resumed') {
        resumedIds.add(String(entry.run.id));
        console.error(`${logPrefix} run ${entry.run.id} resumed; cancellation escalation withheld`);
      }
    } catch (error) {
      failedCancelIds.add(String(entry.run.id));
      console.error(`${logPrefix} could NOT stop ${describeRun(entry, lane)}: ${error.message}`);
    }
  }
  const plan = {
    ...plannedActions,
    cancel: plannedActions.cancel.filter((entry) => !resumedIds.has(String(entry.run.id))),
  };
  // A target that resumed was not stopped, so there is no queue to hand over to.
  if (!lane.redispatch) plan.followUp = plan.cancel.length > 0 ? 'queue-resumes' : 'none';

  let historyOk = recentPageOk;
  // Everything from here to the dispatch is production-deploy's recovery: the
  // OTA lane has nothing to refresh, because nothing it decides depends on it.
  if (lane.redispatch && (hadCandidates || plan.recoveringCancelledRun)) {
    try {
      const currentHeadSha = github.getHeadSha ? github.getHeadSha() : headSha;
      const freshHistory = github.listRuns();
      if (!freshHistory.recentPageOk) throw new Error('incomplete production deploy history');
      historyOk = true;
      // Recompute follow-up against real state, without pretending planned
      // cancellations have completed. Pending runs may have changed meanwhile.
      const plannedIds = new Set(plan.cancel.map((entry) => String(entry.run.id)));
      const survivor = freshHistory.runs.some(
        (run) => !(dryRun && plannedIds.has(String(run.id))) && (isHoldingRun(run) || run.status === 'pending'),
      );
      const headDeployed = freshHistory.runs.some(
        (run) => run.head_sha === currentHeadSha && run.status === 'completed' && run.conclusion === 'success',
      );
      const retried = freshHistory.runs.some(
        (run) => run.head_sha === currentHeadSha && run.event === 'workflow_dispatch',
      );
      plan.recoveringCancelledRun = isLatestRunCancelled(freshHistory.runs);
      const recoveryStillNeeded = hadCandidates || plan.recoveringCancelledRun;
      plan.redispatch = recoveryStillNeeded && !survivor && !headDeployed && !retried && currentHeadSha !== '';
      plan.followUp = !recoveryStillNeeded
        ? 'none'
        : survivor
          ? 'queued-run-takes-over'
          : headDeployed
            ? 'head-already-deployed'
            : plan.redispatch
              ? 'redispatched'
              : 'needs-intervention';
    } catch (error) {
      historyOk = false;
      console.error(`${logPrefix} could not refresh run history: ${error.message}`);
    }
  }
  let dispatched = false;
  let dispatchFailed = false;
  if (lane.redispatch && plan.redispatch && failedCancelIds.size === 0 && historyOk) {
    try {
      if (!dryRun) github.dispatchRun('main');
      dispatched = true;
    } catch (error) {
      dispatchFailed = true;
      console.error(`${logPrefix} dispatch failed: ${error.message}`);
    }
  }
  if (failedCancelIds.size > 0) plan.followUp = 'cancel-failed';
  else if (lane.redispatch && (!historyOk || dispatchFailed)) plan.followUp = 'dispatch-deferred';

  const summary = formatSummary(plan, { dryRun, failedCancelIds, dispatched, lane });
  console.error(`${logPrefix} ${summary}`);
  const discordContent = dryRun ? '' : formatDiscordContent(plan, { runUrlBase, failedCancelIds, lane });
  if (discordContent !== '' && discordFilePath) writeFileSync(discordFilePath, discordContent, 'utf8');
  if (outputPath) appendFileSync(outputPath, `notify=${discordContent === '' ? 'false' : 'true'}\n`, 'utf8');
  // An incomplete run listing fails both lanes: a watchdog that cannot see the
  // lane must go red rather than report "all clear".
  return { ...plan, failed: !dryRun && (failedCancelIds.size > 0 || !historyOk || dispatchFailed) };
}

function resolveLane(laneName) {
  const lane = Object.hasOwn(LANES, laneName) ? LANES[laneName] : undefined;
  if (lane === undefined) {
    throw new Error(`unknown --lane "${laneName}"; expected one of: ${Object.keys(LANES).join(', ')}`);
  }
  return lane;
}

function parseCliArguments(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY ?? '',
    lane: PRODUCTION_DEPLOY_LANE,
    headSha: process.env.GITHUB_SHA ?? '',
    runUrlBase: '',
    discordFilePath: '',
    outputPath: process.env.GITHUB_OUTPUT ?? '',
    dryRun: false,
  };

  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
    const argument = argv[argumentIndex];
    const optionValue = argv[argumentIndex + 1];
    switch (argument) {
      case '--lane':
        options.lane = resolveLane(optionValue ?? '');
        argumentIndex += 1;
        break;
      case '--head':
        options.headSha = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--discord-file':
        options.discordFilePath = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        break;
    }
  }

  if (options.repository !== '') {
    options.runUrlBase = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${options.repository}/actions/runs`;
  }
  return options;
}

if (process.argv[1] === scriptPath) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const result = await runCli({
      ...options,
      github: createCliGitHub({
        repository: options.repository,
        workflowFile: options.lane.workflowFile,
        branch: options.lane.branch,
      }),
    });
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(`production-deploy-watchdog: ${error.message}`);
    process.exit(1);
  }
}

export {
  DISCORD_CONTENT_LIMIT,
  DEFAULT_RUNNING_ALERT_MINUTES,
  DEFAULT_STALL_MINUTES,
  DEFAULT_MAX_RUN_MINUTES,
  CANCEL_GRACE_MS,
  FORCE_CONFIRM_MS,
  LANES,
  MOBILE_OTA_LANE,
  PRODUCTION_DEPLOY_LANE,
  cancelAndConfirm,
  classifyRun,
  createCliGitHub,
  formatDiscordContent,
  formatDuration,
  formatSummary,
  isHoldingRun,
  isParked,
  laneRules,
  parseCliArguments,
  planWatchdogActions,
  runCli,
};
