importScripts('gitlab-shared.js');

const POLL_ALARM_NAME = 'gitlab-mr-poll';
const MAX_CONSECUTIVE_FAILURES = 3;

chrome.runtime.onInstalled.addListener(schedulePolling);
chrome.runtime.onStartup.addListener(schedulePolling);
chrome.runtime.onStartup.addListener(promptUnlockIfLocked);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM_NAME) runPollCycle();
});
chrome.notifications.onClicked.addListener(handleNotificationClick);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'poll-now') {
    schedulePolling(); // pick up a possibly-changed poll interval
    runPollCycle();
  }
  if (message?.type === 'test-sound' && message.sound) {
    playNotificationSound(message.sound);
  }
});

async function schedulePolling() {
  const { pollIntervalMinutes } = await getSettings();
  chrome.alarms.create(POLL_ALARM_NAME, {
    periodInMinutes: pollIntervalMinutes,
    delayInMinutes: 0.1,
  });
}

async function runPollCycle() {
  try {
    const result = await pollAllRepos();
    if (result === 'locked') return; // leave the locked badge/title as-is
    await chrome.storage.local.set({ pollFailureCount: 0 });
    clearErrorBadge();
  } catch (err) {
    console.error('[GitLab MR Dashboard] poll failed:', err);
    const { pollFailureCount = 0 } = await chrome.storage.local.get('pollFailureCount');
    const nextCount = pollFailureCount + 1;
    await chrome.storage.local.set({ pollFailureCount: nextCount });
    if (nextCount >= MAX_CONSECUTIVE_FAILURES) {
      setErrorBadge(err.message || 'unknown error');
    }
  }
}

// Polls every configured repo in turn (sequentially, so the shared
// mrSnapshots/lastPollAt maps below never race each other) and aggregates
// the badge across all of them.
async function pollAllRepos() {
  const settings = await getSettings();

  // PIN-lock is on but nobody has unlocked this browser session yet — there
  // is no key material available anywhere to derive the token from. This
  // isn't a failure, just a wait-for-the-user state.
  if (settings.pinLockEnabled && !settings.token) {
    setLockedBadge();
    await promptUnlockIfLocked();
    return 'locked';
  }

  if (!settings.token || settings.projectPaths.length === 0) return;

  const currentUsername = await resolveUsername(settings.baseUrl, settings.token, settings);

  const stored = await chrome.storage.local.get([
    'mrSnapshots',
    'trackingInitialized',
    'lastPollAt',
  ]);
  const mrSnapshotsByRepo = { ...(stored.mrSnapshots || {}) };
  const initializedByRepo = { ...(stored.trackingInitialized || {}) };
  const lastPollByRepo = { ...(stored.lastPollAt || {}) };

  let totalMyReview = 0;
  let totalNeedsReview = 0;

  for (const projectPath of settings.projectPaths) {
    const result = await pollRepo({
      settings,
      projectPath,
      currentUsername,
      snapshots: mrSnapshotsByRepo[projectPath] || {},
      isFirstRun: !initializedByRepo[projectPath],
      since: lastPollByRepo[projectPath],
    });

    mrSnapshotsByRepo[projectPath] = result.snapshots;
    initializedByRepo[projectPath] = true;
    lastPollByRepo[projectPath] = result.pollStartedAt;
    totalMyReview += result.myReviewCount;
    totalNeedsReview += result.needsReviewCount;
  }

  await chrome.storage.local.set({
    mrSnapshots: mrSnapshotsByRepo,
    trackingInitialized: initializedByRepo,
    lastPollAt: lastPollByRepo,
  });

  refreshBadge({ myReviewCount: totalMyReview, needsReviewCount: totalNeedsReview });
}

async function pollRepo({ settings, projectPath, currentUsername, snapshots, isFirstRun, since }) {
  const { baseUrl, token } = settings;
  const encodedProject = encodeURIComponent(projectPath);
  const pollStartedAt = new Date().toISOString();

  const mrs = await fetchMrsSince(baseUrl, token, encodedProject, isFirstRun ? null : since);
  const approvedByIid = await fetchApprovedState(baseUrl, token, encodedProject, mrs);

  const nextSnapshots = { ...snapshots };
  for (const mr of mrs) {
    const key = String(mr.iid);
    const prev = snapshots[key];
    const status = describeMrStatus(mr, prev, approvedByIid);

    if (!isFirstRun) {
      await notifyForTransition({ mr, prev, status, currentUsername, projectPath, settings });
    }

    nextSnapshots[key] = status.snapshot;
  }

  const [needsReviewCount, myReviewCount] = await Promise.all([
    countNeedsReview(baseUrl, token, projectPath),
    countPendingReviews(baseUrl, token, projectPath, currentUsername),
  ]);

  return { snapshots: nextSnapshots, pollStartedAt, needsReviewCount, myReviewCount };
}

// First run bootstraps a full snapshot of all open MRs (silent — nothing to
// diff against yet). Every later poll only re-fetches what changed since the
// last run, using GitLab's own updated_at index instead of paging everything.
async function fetchMrsSince(baseUrl, token, encodedProject, since) {
  const query = since
    ? `state=all&order_by=updated_at&updated_after=${encodeURIComponent(since)}`
    : 'state=opened';
  return fetchAllPages(baseUrl, token, `/projects/${encodedProject}/merge_requests?${query}`);
}

async function fetchApprovedState(baseUrl, token, encodedProject, mrs) {
  const openMrs = mrs.filter((mr) => mr.state === 'opened');
  const approvedFlags = await mapWithConcurrency(
    openMrs,
    DETAIL_FETCH_CONCURRENCY,
    async (mr) => {
      try {
        const approvals = await gitlabFetch(
          baseUrl,
          token,
          `/projects/${encodedProject}/merge_requests/${mr.iid}/approvals`
        );
        return Boolean(approvals.approved);
      } catch {
        return false;
      }
    }
  );

  const approvedByIid = new Map();
  openMrs.forEach((mr, index) => approvedByIid.set(mr.iid, approvedFlags[index]));
  return approvedByIid;
}

// Derives this poll's view of one MR (draft/approved/pipeline/conflict
// state) plus the snapshot to persist for next time's diff.
function describeMrStatus(mr, prev, approvedByIid) {
  const draft = isDraft(mr);
  const pipelineFailed = isPipelineFailed(mr);
  const hasConflicts = hasMergeConflicts(mr);
  const approved =
    mr.state === 'opened'
      ? approvedByIid.get(mr.iid) === true
      : Boolean(prev && prev.approved);

  return {
    draft,
    pipelineFailed,
    hasConflicts,
    approved,
    snapshot: {
      state: mr.state,
      draft,
      pipelineFailed,
      hasConflicts,
      sha: mr.sha,
      approved,
    },
  };
}

function repoLabel(projectPath) {
  const parts = projectPath.split('/');
  return parts[parts.length - 1] || projectPath;
}

async function notifyForTransition({ mr, prev, status, currentUsername, projectPath, settings }) {
  const { draft, pipelineFailed, hasConflicts, approved } = status;
  const prefs = settings.notifications;
  const isOwnMr = (mr.author && mr.author.username) === currentUsername;
  const tag = repoLabel(projectPath);
  const send = (title, message) => notify(`${title} (${tag})`, message, mr.web_url, settings);

  if (!prev) {
    if (!draft && prefs.newMr) {
      const authorName = (mr.author && mr.author.name) || 'unknown';
      await send(`New MR !${mr.iid}`, `${mr.title}\nby ${authorName}`);
    }
    return;
  }

  if (prev.state === 'opened' && mr.state === 'merged') {
    if (prefs.merged) await send(`MR merged: !${mr.iid}`, mr.title);
    return;
  }

  if (mr.state !== 'opened') return;

  if (prev.draft && !draft) {
    if (prefs.readyForReview) await send(`Ready for review: !${mr.iid}`, mr.title);
  } else if (!draft && prev.sha && mr.sha && prev.sha !== mr.sha) {
    if (prefs.newCommits) await send(`New commits on !${mr.iid}`, mr.title);
  }

  if (!prev.approved && approved && prefs.approved) {
    await send(`MR approved: !${mr.iid}`, mr.title);
  }

  // Pipeline-failed and new-conflict notifications only page the MR's own
  // author — everyone else already sees them as status pills in the popup.
  if (!prev.pipelineFailed && pipelineFailed && !draft && isOwnMr && prefs.pipelineFailed) {
    await send(`Pipeline failed: !${mr.iid}`, mr.title);
  }
  if (!prev.hasConflicts && hasConflicts && !draft && isOwnMr && prefs.newConflict) {
    await send(`New conflict on !${mr.iid}`, mr.title);
  }
}

let notificationSeq = 0;

async function notify(title, message, url, settings) {
  const id = `gitlab-mr-${Date.now()}-${notificationSeq++}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 1,
  });

  const { notificationUrls = {} } = await chrome.storage.session.get('notificationUrls');
  notificationUrls[id] = url;
  await chrome.storage.session.set({ notificationUrls });

  if (settings.soundEnabled && settings.soundChoice !== 'none') {
    playNotificationSound(settings.soundChoice);
  }
}

async function handleNotificationClick(notificationId) {
  if (notificationId === UNLOCK_NUDGE_NOTIFICATION_ID) {
    // A notification click is a genuine user gesture, so this has a much
    // better chance of succeeding than the unattended attempt that likely
    // triggered this fallback notification in the first place.
    tryOpenPopup();
    chrome.notifications.clear(notificationId);
    return;
  }

  const { notificationUrls = {} } = await chrome.storage.session.get('notificationUrls');
  const url = notificationUrls[notificationId];
  if (url) chrome.tabs.create({ url });
  chrome.notifications.clear(notificationId);
}

// ---------------------------------------------------------------------------
// Auto-open the popup when the extension wakes up locked, so the user isn't
// left wondering why nothing's syncing. chrome.action.openPopup() has real
// platform restrictions (Chrome version, window focus) that can make it
// silently fail outside a direct user gesture — the notification below is
// the fallback for exactly that case, and its own click handler above tries
// again from within a genuine gesture.
// ---------------------------------------------------------------------------

const UNLOCK_NUDGE_NOTIFICATION_ID = 'gitlab-mr-unlock-nudge';

async function promptUnlockIfLocked() {
  const settings = await getSettings();
  if (!settings.pinLockEnabled || settings.token) return; // not locked

  const { hasPromptedUnlock } = await chrome.storage.session.get('hasPromptedUnlock');
  if (hasPromptedUnlock) return; // already nudged once this browser session
  await chrome.storage.session.set({ hasPromptedUnlock: true });

  const opened = await tryOpenPopup();
  if (!opened) {
    chrome.notifications.create(UNLOCK_NUDGE_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'GitLab MR Dashboard is locked',
      message: 'Click here to open it and enter your password (or use Touch ID).',
      priority: 2,
    });
  }
}

async function tryOpenPopup() {
  try {
    await chrome.action.openPopup();
    return true;
  } catch (err) {
    console.warn('[GitLab MR Dashboard] could not auto-open the popup:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sound playback — service workers have no <audio>, so a short-lived
// offscreen document plays the chosen tone on request.
// ---------------------------------------------------------------------------

async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play a short sound when a GitLab MR notification fires.',
    });
  } catch (err) {
    if (!String(err.message || '').includes('single offscreen')) throw err;
  }
}

async function playNotificationSound(soundChoice) {
  try {
    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({ type: 'play-sound', sound: soundChoice });
  } catch (err) {
    console.warn('[GitLab MR Dashboard] could not play notification sound:', err);
  }
}
