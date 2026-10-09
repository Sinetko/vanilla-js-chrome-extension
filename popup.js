// ---------------------------------------------------------------------------
// DOM references & constants
// ---------------------------------------------------------------------------

const els = {
  appHeader: document.getElementById('appHeader'),
  openProjectBtn: document.getElementById('openProjectBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  collapseBtn: document.getElementById('collapseBtn'),
  infoBtn: document.getElementById('infoBtn'),
  infoPanel: document.getElementById('infoPanel'),
  infoVersion: document.getElementById('infoVersion'),
  closeInfoBtn: document.getElementById('closeInfoBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  settingsTabBtns: Array.from(document.querySelectorAll('.settings-tab-btn')),
  settingsTabPanels: Array.from(document.querySelectorAll('.settings-tab-panel')),
  repoSwitcher: document.getElementById('repoSwitcher'),

  welcomeScreen: document.getElementById('welcomeScreen'),
  getStartedBtn: document.getElementById('getStartedBtn'),

  lockScreen: document.getElementById('lockScreen'),
  unlockPasswordInput: document.getElementById('unlockPasswordInput'),
  unlockShowCheckbox: document.getElementById('unlockShowCheckbox'),
  unlockBtn: document.getElementById('unlockBtn'),
  unlockError: document.getElementById('unlockError'),
  biometricUnlockBtn: document.getElementById('biometricUnlockBtn'),
  biometricOrDivider: document.getElementById('biometricOrDivider'),

  pinSetupScreen: document.getElementById('pinSetupScreen'),
  setupPasswordInput: document.getElementById('setupPasswordInput'),
  setupConfirmPasswordInput: document.getElementById('setupConfirmPasswordInput'),
  setupShowCheckbox: document.getElementById('setupShowCheckbox'),
  setupPinBtn: document.getElementById('setupPinBtn'),
  setupPinError: document.getElementById('setupPinError'),
  setupCopyBtn: document.getElementById('setupCopyBtn'),
  setupCopyStatus: document.getElementById('setupCopyStatus'),

  pinLockStatus: document.getElementById('pinLockStatus'),
  newPinInput: document.getElementById('newPinInput'),
  confirmPinInput: document.getElementById('confirmPinInput'),
  newPinShowCheckbox: document.getElementById('newPinShowCheckbox'),
  setPinBtn: document.getElementById('setPinBtn'),
  newPinCopyBtn: document.getElementById('newPinCopyBtn'),
  changePinStatus: document.getElementById('changePinStatus'),

  biometricStatus: document.getElementById('biometricStatus'),
  enrollBiometricBtn: document.getElementById('enrollBiometricBtn'),
  removeBiometricBtn: document.getElementById('removeBiometricBtn'),

  baseUrlInput: document.getElementById('baseUrlInput'),
  tokenInput: document.getElementById('tokenInput'),
  tokenHelpLink: document.getElementById('tokenHelpLink'),
  usernameInput: document.getElementById('usernameInput'),

  repoPathInput: document.getElementById('repoPathInput'),
  addRepoBtn: document.getElementById('addRepoBtn'),
  repoManageList: document.getElementById('repoManageList'),

  pollIntervalSelect: document.getElementById('pollIntervalSelect'),
  themeSelect: document.getElementById('themeSelect'),

  notifNewMr: document.getElementById('notifNewMr'),
  notifNewCommits: document.getElementById('notifNewCommits'),
  notifReadyForReview: document.getElementById('notifReadyForReview'),
  notifApproved: document.getElementById('notifApproved'),
  notifMerged: document.getElementById('notifMerged'),
  notifPipelineFailed: document.getElementById('notifPipelineFailed'),
  notifNewConflict: document.getElementById('notifNewConflict'),

  soundEnabledCheckbox: document.getElementById('soundEnabledCheckbox'),
  soundChoiceSelect: document.getElementById('soundChoiceSelect'),
  testSoundBtn: document.getElementById('testSoundBtn'),

  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  testConnectionBtn: document.getElementById('testConnectionBtn'),
  settingsStatus: document.getElementById('settingsStatus'),

  statusMessage: document.getElementById('statusMessage'),
  content: document.getElementById('content'),
  statsSection: document.getElementById('statsSection'),

  totalOpen: document.getElementById('totalOpen'),
  totalApproved: document.getElementById('totalApproved'),
  totalFailed: document.getElementById('totalFailed'),
  totalPending: document.getElementById('totalPending'),
  myTotal: document.getElementById('myTotal'),
  myApproved: document.getElementById('myApproved'),
  myNotApproved: document.getElementById('myNotApproved'),
  needsMyReview: document.getElementById('needsMyReview'),

  authorTabs: document.getElementById('authorTabs'),
  mrList: document.getElementById('mrList'),
  searchInput: document.getElementById('searchInput'),
  sortSelect: document.getElementById('sortSelect'),
  draftFilterSelect: document.getElementById('draftFilterSelect'),
  staleFilterSelect: document.getElementById('staleFilterSelect'),
  labelFilterSelect: document.getElementById('labelFilterSelect'),
};

const ALL_TAB_KEY = '__all__';
const NEEDS_REVIEW_TAB_KEY = '__needs_review__';
const MY_REVIEW_TAB_KEY = '__my_review__';
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const UI_STATE_KEYS = [
  'uiSortValue',
  'uiDraftFilter',
  'uiStaleFilter',
  'uiLabelFilter',
  'uiActiveTab',
  'uiDashboardCollapsed',
];

// ---------------------------------------------------------------------------
// Module state — populated by loadDashboard(), read by the render functions.
// ---------------------------------------------------------------------------

let currentUsername = '';
let allMrs = [];
let mrsByAuthor = new Map(); // username -> { name, mrs: [] }
let needsReviewMrs = []; // no unresolved discussions, not enough approvals yet
let myReviewMrs = []; // I'm a requested reviewer and haven't approved
let activeAuthorUsername = null;
let desiredLabelFilter = null; // pending restore from persisted UI state
let pendingRepoList = []; // repo list being edited in the (still open) settings panel
let dashboardCollapsed = false;

// ---------------------------------------------------------------------------
// UI state persistence (sort/filter/tab/collapse choices survive reopens)
// ---------------------------------------------------------------------------

function loadUiState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(UI_STATE_KEYS, resolve);
  });
}

function saveUiState() {
  chrome.storage.local.set({
    uiSortValue: els.sortSelect.value,
    uiDraftFilter: els.draftFilterSelect.value,
    uiStaleFilter: els.staleFilterSelect.value,
    uiLabelFilter: els.labelFilterSelect.value,
    uiActiveTab: activeAuthorUsername,
  });
}

function setDashboardCollapsed(value) {
  dashboardCollapsed = value;
  els.statsSection.classList.toggle('collapsed', value);
  els.collapseBtn.textContent = value ? '⌄' : '⌃';
  els.collapseBtn.title = value ? 'Expand stats' : 'Collapse stats';
}

// ---------------------------------------------------------------------------
// Dashboard cache — one entry per repo, keyed by baseUrl+projectPath. Lets
// the popup render instantly on open (or on switching repos) from the last
// known state, then silently refetch instead of blocking on every visit.
// ---------------------------------------------------------------------------

function dashboardCacheKey(baseUrl, projectPath) {
  return `${baseUrl}::${projectPath}`;
}

async function getCachedDashboard(baseUrl, projectPath) {
  const { dashboardCaches } = await chrome.storage.local.get('dashboardCaches');
  return (dashboardCaches && dashboardCaches[dashboardCacheKey(baseUrl, projectPath)]) || null;
}

async function setCachedDashboard(baseUrl, projectPath, data) {
  const { dashboardCaches } = await chrome.storage.local.get('dashboardCaches');
  const next = { ...(dashboardCaches || {}) };
  next[dashboardCacheKey(baseUrl, projectPath)] = {
    currentUsername: data.currentUsername,
    allMrs: data.allMrs,
  };
  await chrome.storage.local.set({ dashboardCaches: next });
}

// ---------------------------------------------------------------------------
// Status / loading UI
// ---------------------------------------------------------------------------

function showStatus(message, isError) {
  els.statusMessage.textContent = message;
  els.statusMessage.classList.remove('hidden');
  els.statusMessage.classList.toggle('error', Boolean(isError));
  els.content.classList.add('hidden');
}

function hideStatus() {
  els.statusMessage.classList.add('hidden');
  els.content.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Data fetching — pure network + transform, no DOM access. Kept separate
// from rendering so the cached-render path and the live-fetch path can both
// feed the same computeAndRender() step.
// ---------------------------------------------------------------------------

async function fetchDashboardData({ baseUrl, activeProjectPath, token, username }) {
  const encodedProject = encodeURIComponent(activeProjectPath);
  const resolvedUsername = await resolveUsername(baseUrl, token, { username });

  const mrs = await fetchAllPages(
    baseUrl,
    token,
    `/projects/${encodedProject}/merge_requests?state=opened&with_labels_details=true`
  );

  const details = await mapWithConcurrency(
    mrs,
    DETAIL_FETCH_CONCURRENCY,
    (mr) => fetchMrDetails(baseUrl, token, encodedProject, mr)
  );

  const allMrsData = mrs.map((mr, index) => enrichMr(mr, details[index], baseUrl));
  return { currentUsername: resolvedUsername, allMrs: allMrsData };
}

function enrichMr(mr, details, baseUrl) {
  const draft = isDraft(mr);
  const pipelineFailed = isPipelineFailed(mr);
  const hasConflicts = hasMergeConflicts(mr);

  return {
    ...mr,
    draft,
    pipelineFailed,
    hasConflicts,
    failed: pipelineFailed || hasConflicts,
    approved: details.approved,
    approvedBy: details.approvedBy,
    approvalsRequired: details.approvalsRequired,
    lastCommitAt: details.lastCommitAt,
    unresolvedThreads: details.unresolvedThreads,
    untouched: isUntouched(mr, details.approvedBy.length, draft),
    reviewers: (mr.reviewers || []).map((reviewer) => ({
      username: reviewer.username,
      name: reviewer.name,
    })),
    avatarUrl: resolveAvatarUrl(baseUrl, mr.author && mr.author.avatar_url),
    labels: normalizeLabels(mr),
  };
}

async function loadDashboard({ silent = false } = {}) {
  const settings = await getSettings();
  if (!settings.token || !settings.activeProjectPath) {
    showStatus('Set a repository and token in ⚙ Settings first.', false);
    return;
  }

  if (!silent) showStatus('Loading…', false);

  try {
    const data = await fetchDashboardData(settings);
    currentUsername = data.currentUsername;
    allMrs = data.allMrs;
    computeAndRender();
    hideStatus();
    setCachedDashboard(settings.baseUrl, settings.activeProjectPath, data);
  } catch (err) {
    if (silent) {
      console.warn('[GitLab MR Dashboard] background refresh failed:', err);
    } else {
      showStatus(err.message || 'Failed to load data.', true);
    }
  }
}

// ---------------------------------------------------------------------------
// Compute derived state (grouping, stats) and render everything. Operates
// purely on module state — safe to call after either a cache restore or a
// fresh fetch. Note: the toolbar badge is NOT touched here — it's a global
// total aggregated across every configured repo, owned exclusively by
// background.js's poll cycle.
// ---------------------------------------------------------------------------

function computeAndRender() {
  mrsByAuthor = new Map();
  let totalApproved = 0;
  let totalFailed = 0;
  const myMrs = [];

  allMrs.forEach((mr) => {
    if (mr.approved) totalApproved += 1;
    if (mr.failed) totalFailed += 1;

    const authorUsername = (mr.author && mr.author.username) || 'unknown';
    const authorName = (mr.author && mr.author.name) || authorUsername;
    if (!mrsByAuthor.has(authorUsername)) {
      mrsByAuthor.set(authorUsername, { name: authorName, mrs: [] });
    }
    mrsByAuthor.get(authorUsername).mrs.push(mr);

    if (authorUsername === currentUsername) myMrs.push(mr);
  });

  const allLabelNames = [
    ...new Set(allMrs.flatMap((mr) => mr.labels.map((label) => label.name))),
  ].sort((a, b) => a.localeCompare(b));
  populateLabelFilterOptions(allLabelNames);

  // Not enough approvals yet to merge, and nothing blocking a reviewer from
  // approving right now. Doesn't matter who approves — GitLab only requires
  // a fixed count, so this isn't restricted to "my" review the way
  // myReviewMrs below is.
  needsReviewMrs = allMrs.filter(
    (mr) =>
      !mr.draft &&
      mr.unresolvedThreads === 0 &&
      mr.approvedBy.length < mr.approvalsRequired
  );

  myReviewMrs = allMrs.filter(
    (mr) =>
      (mr.author && mr.author.username) !== currentUsername &&
      mr.reviewers.some((reviewer) => reviewer.username === currentUsername) &&
      !mr.approvedBy.some((approver) => approver.username === currentUsername)
  );

  const totalOpen = allMrs.length;
  const totalPending = totalOpen - totalApproved;
  const myApproved = myMrs.filter((mr) => mr.approved).length;
  const myNotApproved = myMrs.length - myApproved;

  els.totalOpen.textContent = String(totalOpen);
  els.totalApproved.textContent = String(totalApproved);
  els.totalFailed.textContent = String(totalFailed);
  els.totalPending.textContent = String(totalPending);
  els.myTotal.textContent = String(myMrs.length);
  els.myApproved.textContent = String(myApproved);
  els.myNotApproved.textContent = String(myNotApproved);
  els.needsMyReview.textContent = String(myReviewMrs.length);

  if (
    !activeAuthorUsername ||
    (activeAuthorUsername !== ALL_TAB_KEY &&
      activeAuthorUsername !== NEEDS_REVIEW_TAB_KEY &&
      activeAuthorUsername !== MY_REVIEW_TAB_KEY &&
      !mrsByAuthor.has(activeAuthorUsername))
  ) {
    activeAuthorUsername = mrsByAuthor.has(currentUsername)
      ? currentUsername
      : ALL_TAB_KEY;
  }

  renderAuthorTabs();
  renderMrList();
}

function populateLabelFilterOptions(names) {
  const target = desiredLabelFilter || els.labelFilterSelect.value;
  desiredLabelFilter = null;

  els.labelFilterSelect.innerHTML = '';
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'All labels';
  els.labelFilterSelect.appendChild(allOption);

  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    els.labelFilterSelect.appendChild(option);
  });

  els.labelFilterSelect.value = names.includes(target) ? target : 'all';
}

// ---------------------------------------------------------------------------
// Rendering: author tabs
// ---------------------------------------------------------------------------

function renderAuthorTabs() {
  els.authorTabs.innerHTML = '';

  const usernames = [...mrsByAuthor.keys()].sort((a, b) => {
    if (a === currentUsername) return -1;
    if (b === currentUsername) return 1;
    return mrsByAuthor.get(a).name.localeCompare(mrsByAuthor.get(b).name);
  });

  const tabDefs = [
    { key: ALL_TAB_KEY, label: 'All', count: allMrs.length },
    {
      key: NEEDS_REVIEW_TAB_KEY,
      label: 'Needs review',
      count: needsReviewMrs.length,
    },
    {
      key: MY_REVIEW_TAB_KEY,
      label: 'Needs my review',
      count: myReviewMrs.length,
    },
    ...usernames.map((username) => ({
      key: username,
      label: username === currentUsername ? 'Me' : mrsByAuthor.get(username).name,
      count: mrsByAuthor.get(username).mrs.length,
      avatarUrl: mrsByAuthor.get(username).mrs[0]?.avatarUrl,
    })),
  ];

  tabDefs.forEach(({ key, label, count, avatarUrl }) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `author-tab${key === activeAuthorUsername ? ' active' : ''}`;

    if (avatarUrl) {
      const avatar = document.createElement('img');
      avatar.className = 'author-tab-avatar';
      avatar.src = avatarUrl;
      avatar.alt = '';
      tab.appendChild(avatar);
    }

    tab.appendChild(document.createTextNode(label));

    const countEl = document.createElement('span');
    countEl.className = 'author-tab-count';
    countEl.textContent = String(count);
    tab.appendChild(countEl);

    tab.addEventListener('click', () => {
      activeAuthorUsername = key;
      saveUiState();
      renderAuthorTabs();
      renderMrList();
    });

    els.authorTabs.appendChild(tab);
  });
}

// ---------------------------------------------------------------------------
// Filtering & sorting
// ---------------------------------------------------------------------------

function getActiveMrs() {
  if (activeAuthorUsername === ALL_TAB_KEY) return allMrs;
  if (activeAuthorUsername === NEEDS_REVIEW_TAB_KEY) return needsReviewMrs;
  if (activeAuthorUsername === MY_REVIEW_TAB_KEY) return myReviewMrs;
  return mrsByAuthor.get(activeAuthorUsername)?.mrs || [];
}

function applyFiltersAndSort(mrs) {
  const draftFilter = els.draftFilterSelect.value;
  const staleFilter = els.staleFilterSelect.value;
  const labelFilter = els.labelFilterSelect.value;
  const searchTerm = els.searchInput.value.trim().toLowerCase();
  const now = Date.now();

  let result = mrs.filter((mr) => {
    if (draftFilter === 'hide' && mr.draft) return false;
    if (draftFilter === 'only' && !mr.draft) return false;

    if (staleFilter !== 'all') {
      const reference = mr.lastCommitAt || mr.created_at;
      const referenceTime = reference ? new Date(reference).getTime() : NaN;
      const isStale = Number.isNaN(referenceTime) || now - referenceTime > STALE_MS;
      if (staleFilter === 'hide' && isStale) return false;
      if (staleFilter === 'only' && !isStale) return false;
    }

    if (labelFilter !== 'all' && !mr.labels.some((label) => label.name === labelFilter)) {
      return false;
    }

    if (searchTerm && !`!${mr.iid} ${mr.title}`.toLowerCase().includes(searchTerm)) {
      return false;
    }

    return true;
  });

  const [field, direction] = els.sortSelect.value.split('-');
  const sign = direction === 'asc' ? 1 : -1;
  result = [...result].sort((a, b) => {
    const aTime = new Date(
      field === 'updated' ? a.lastCommitAt || a.created_at : a.created_at
    ).getTime();
    const bTime = new Date(
      field === 'updated' ? b.lastCommitAt || b.created_at : b.created_at
    ).getTime();
    return (aTime - bTime) * sign;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Rendering: MR list
// ---------------------------------------------------------------------------

function renderMrList() {
  els.mrList.innerHTML = '';

  const mrs = applyFiltersAndSort(getActiveMrs());

  if (mrs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'mr-empty';
    empty.textContent = getActiveMrs().length
      ? 'No merge requests match the current filters.'
      : 'No open merge requests.';
    els.mrList.appendChild(empty);
    return;
  }

  mrs.forEach((mr) => els.mrList.appendChild(buildMrListItem(mr)));
}

function buildMrListItem(mr) {
  const item = document.createElement('li');
  item.className = 'mr-item';
  item.appendChild(buildMrHeader(mr));

  if (mr.labels.length) item.appendChild(buildMrLabelsRow(mr));

  item.appendChild(buildMrDatesRow(mr));

  if (mr.approvalsRequired > 0) item.appendChild(buildMrApprovalRow(mr));
  if (mr.unresolvedThreads > 0) item.appendChild(buildMrThreadsRow(mr));

  item.addEventListener('click', () => {
    // active: false keeps focus on the popup so it doesn't auto-close,
    // letting you open several MRs in a row from the same list.
    chrome.tabs.create({ url: mr.web_url, active: false });
  });

  return item;
}

function buildMrHeader(mr) {
  const header = document.createElement('div');
  header.className = 'mr-item-header';

  if (mr.avatarUrl) {
    const avatar = document.createElement('img');
    avatar.className = 'mr-avatar';
    avatar.src = mr.avatarUrl;
    avatar.alt = '';
    header.appendChild(avatar);
  }

  const badge = document.createElement('span');
  badge.className = `mr-badge ${mr.failed ? 'failed' : mr.approved ? 'approved' : 'pending'}`;
  header.appendChild(badge);

  const title = document.createElement('span');
  title.className = 'mr-title';
  title.textContent = `!${mr.iid} ${mr.title}`;
  title.title = mr.title;
  header.appendChild(title);

  if (mr.draft) {
    header.appendChild(buildStatusPill('Draft', 'muted'));
  }
  if (mr.pipelineFailed) {
    header.appendChild(buildStatusPill('CI failed', 'danger'));
  }
  if (mr.hasConflicts) {
    header.appendChild(buildStatusPill('Conflicts', 'danger'));
  }
  if (mr.untouched) {
    header.appendChild(buildStatusPill('Untouched', 'danger', 'No comments or approvals yet'));
  }

  return header;
}

function buildStatusPill(text, variant, tooltip) {
  const pill = document.createElement('span');
  pill.className = `mr-status-badge mr-status-badge--${variant}`;
  pill.textContent = text;
  if (tooltip) pill.title = tooltip;
  return pill;
}

function buildMrLabelsRow(mr) {
  const row = document.createElement('div');
  row.className = 'mr-labels';
  mr.labels.forEach((label) => {
    const chip = document.createElement('span');
    chip.className = 'mr-label-chip';
    chip.style.background = label.color;
    chip.style.color = label.textColor;
    chip.textContent = label.name;
    row.appendChild(chip);
  });
  return row;
}

function buildMrDatesRow(mr) {
  const row = document.createElement('div');
  row.className = 'mr-meta';

  const created = document.createElement('span');
  created.textContent = `Created ${formatRelativeDate(mr.created_at)}`;
  created.title = formatAbsoluteDate(mr.created_at);

  const lastCommit = document.createElement('span');
  lastCommit.textContent = `Last commit ${formatRelativeDate(mr.lastCommitAt)}`;
  lastCommit.title = formatAbsoluteDate(mr.lastCommitAt);

  row.append(created, ' · ', lastCommit);
  return row;
}

function buildMrApprovalRow(mr) {
  const row = document.createElement('div');
  row.className = `mr-meta${mr.approved ? ' mr-approved-by' : ''}`;
  const names = mr.approvedBy.map((approver) => approver.name).join(', ');
  const progress = `${mr.approvedBy.length}/${mr.approvalsRequired} approvals`;
  row.textContent = names ? `${progress} — ${names}` : progress;
  return row;
}

function buildMrThreadsRow(mr) {
  const row = document.createElement('div');
  row.className = 'mr-meta mr-unresolved-threads';
  const label = mr.unresolvedThreads === 1 ? 'thread' : 'threads';
  row.textContent = `${mr.unresolvedThreads} unresolved ${label}`;
  return row;
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

function formatAbsoluteDate(isoString) {
  if (!isoString) return '–';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRelativeDate(isoString) {
  if (!isoString) return '–';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '–';

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60000) return 'just now';

  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  const diffMonths = Math.round(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;

  return `${Math.round(diffMonths / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  if (theme && theme !== 'system') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// ---------------------------------------------------------------------------
// Repo switcher (header) + repo list manager (settings panel)
// ---------------------------------------------------------------------------

function populateRepoSwitcher(projectPaths, activeProjectPath) {
  els.repoSwitcher.innerHTML = '';
  projectPaths.forEach((path) => {
    const option = document.createElement('option');
    option.value = path;
    option.textContent = path;
    els.repoSwitcher.appendChild(option);
  });
  els.repoSwitcher.value = activeProjectPath;
}

function renderRepoManageList() {
  els.repoManageList.innerHTML = '';

  if (pendingRepoList.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'repo-manage-item';
    empty.textContent = 'No repositories yet — add one above.';
    els.repoManageList.appendChild(empty);
    return;
  }

  pendingRepoList.forEach((path) => {
    const item = document.createElement('li');
    item.className = 'repo-manage-item';

    const label = document.createElement('span');
    label.textContent = path;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'repo-remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      pendingRepoList = pendingRepoList.filter((existing) => existing !== path);
      renderRepoManageList();
    });

    item.append(label, removeBtn);
    els.repoManageList.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function updateTokenHelpLink() {
  const base = (els.baseUrlInput.value.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  els.tokenHelpLink.href = `${base}/-/user_settings/personal_access_tokens`;
}

async function openSettingsPanel() {
  const settings = await getSettings();

  els.baseUrlInput.value = settings.baseUrl;
  els.tokenInput.value = settings.token;
  els.usernameInput.value = settings.username;
  updateTokenHelpLink();

  pendingRepoList = [...settings.projectPaths];
  renderRepoManageList();

  els.pollIntervalSelect.value = String(settings.pollIntervalMinutes);
  els.themeSelect.value = settings.theme;

  els.notifNewMr.checked = settings.notifications.newMr;
  els.notifNewCommits.checked = settings.notifications.newCommits;
  els.notifReadyForReview.checked = settings.notifications.readyForReview;
  els.notifApproved.checked = settings.notifications.approved;
  els.notifMerged.checked = settings.notifications.merged;
  els.notifPipelineFailed.checked = settings.notifications.pipelineFailed;
  els.notifNewConflict.checked = settings.notifications.newConflict;

  els.soundEnabledCheckbox.checked = settings.soundEnabled;
  els.soundChoiceSelect.value = settings.soundChoice;

  els.pinLockStatus.innerHTML = `<strong>Password lock: ${settings.pinLockEnabled ? 'On' : 'Off'}</strong>`;
  els.newPinInput.value = '';
  els.confirmPinInput.value = '';
  els.changePinStatus.textContent = '';

  const biometricSupported = await isBiometricSupported();
  const biometricEnrolled = await isBiometricEnrolled();
  els.biometricStatus.innerHTML = `<strong>Biometric unlock: ${biometricEnrolled ? 'On' : 'Off'}</strong>${
    biometricSupported ? '' : ' (not supported on this device/browser)'
  }`;
  els.enrollBiometricBtn.classList.toggle('hidden', !biometricSupported || biometricEnrolled);
  els.removeBiometricBtn.classList.toggle('hidden', !biometricEnrolled);

  switchSettingsTab('general');
  els.settingsPanel.classList.remove('hidden');
  updatePanelOpenState();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

els.baseUrlInput.addEventListener('input', updateTokenHelpLink);

els.tokenHelpLink.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: els.tokenHelpLink.href });
});

// One screen at a time: the dashboard/MR list stays hidden behind CSS
// (body.panel-open) for as long as either panel below is open, regardless
// of the panel's own internal state — see updatePanelOpenState().
function updatePanelOpenState() {
  const anyPanelOpen =
    !els.settingsPanel.classList.contains('hidden') || !els.infoPanel.classList.contains('hidden');
  document.body.classList.toggle('panel-open', anyPanelOpen);
}

function switchSettingsTab(tabName) {
  els.settingsTabBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  els.settingsTabPanels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.tabPanel !== tabName);
  });
}

els.settingsTabBtns.forEach((btn) => {
  btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
});

els.settingsBtn.addEventListener('click', () => {
  els.settingsPanel.classList.toggle('hidden');
  if (!els.settingsPanel.classList.contains('hidden')) openSettingsPanel();
  updatePanelOpenState();
});

els.infoBtn.addEventListener('click', () => {
  els.infoVersion.textContent = `Version ${chrome.runtime.getManifest().version}`;
  els.infoPanel.classList.toggle('hidden');
  updatePanelOpenState();
});
els.closeInfoBtn.addEventListener('click', () => {
  els.infoPanel.classList.add('hidden');
  updatePanelOpenState();
});

els.collapseBtn.addEventListener('click', () => {
  setDashboardCollapsed(!dashboardCollapsed);
  chrome.storage.local.set({ uiDashboardCollapsed: dashboardCollapsed });
});

els.openProjectBtn.addEventListener('click', async () => {
  const settings = await getSettings();
  chrome.tabs.create({
    url: `${settings.baseUrl}/${settings.activeProjectPath}/-/merge_requests`,
  });
});

els.addRepoBtn.addEventListener('click', () => {
  const path = els.repoPathInput.value.trim().replace(/^\/+|\/+$/g, '');
  if (path && !pendingRepoList.includes(path)) {
    pendingRepoList.push(path);
    renderRepoManageList();
  }
  els.repoPathInput.value = '';
});

els.repoSwitcher.addEventListener('change', async () => {
  const activeProjectPath = els.repoSwitcher.value;
  const settings = await getSettings();
  await saveSettings({ activeProjectPath });
  activeAuthorUsername = null;

  const cached = await getCachedDashboard(settings.baseUrl, activeProjectPath);
  if (cached) {
    currentUsername = cached.currentUsername;
    allMrs = cached.allMrs;
    computeAndRender();
    hideStatus();
    loadDashboard({ silent: true });
  } else {
    loadDashboard();
  }
});

els.saveSettingsBtn.addEventListener('click', async () => {
  const previous = await getSettings();

  const baseUrl = (els.baseUrlInput.value.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const projectPaths = pendingRepoList.length ? pendingRepoList : [DEFAULT_PROJECT_PATH];
  const activeProjectPath = projectPaths.includes(previous.activeProjectPath)
    ? previous.activeProjectPath
    : projectPaths[0];

  const settings = {
    baseUrl,
    projectPaths,
    activeProjectPath,
    token: els.tokenInput.value.trim(),
    username: els.usernameInput.value.trim(),
    pollIntervalMinutes: Number(els.pollIntervalSelect.value),
    theme: els.themeSelect.value,
    notifications: {
      newMr: els.notifNewMr.checked,
      newCommits: els.notifNewCommits.checked,
      readyForReview: els.notifReadyForReview.checked,
      approved: els.notifApproved.checked,
      merged: els.notifMerged.checked,
      pipelineFailed: els.notifPipelineFailed.checked,
      newConflict: els.notifNewConflict.checked,
    },
    soundEnabled: els.soundEnabledCheckbox.checked,
    soundChoice: els.soundChoiceSelect.value,
  };

  try {
    await saveSettings(settings);
  } catch (err) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = err.message || 'Failed to save settings.';
    return;
  }

  if (previous.baseUrl !== settings.baseUrl) {
    // Switching GitLab instance: every cached/tracked repo reference is now
    // stale, so drop it all rather than risk mixing data across servers.
    await chrome.storage.local.remove([
      'mrSnapshots',
      'trackingInitialized',
      'lastPollAt',
      'dashboardCaches',
    ]);
  }

  applyTheme(settings.theme);
  populateRepoSwitcher(settings.projectPaths, settings.activeProjectPath);
  chrome.runtime.sendMessage({ type: 'poll-now' });

  els.settingsStatus.classList.remove('error');
  els.settingsStatus.textContent = 'Saved';
  setTimeout(() => {
    els.settingsStatus.textContent = '';
  }, 1500);
  els.settingsPanel.classList.add('hidden');
  updatePanelOpenState();

  // Settings is only ever reachable after the password screen, so this is
  // normally already true — kept as a defensive fallback, not the primary
  // gate (that's in init()/getStartedBtn/handleSetupPin).
  const updated = await getSettings();
  if (!updated.pinLockEnabled && updated.token) {
    showPinSetupScreen();
  } else {
    loadDashboard();
  }
});

els.testConnectionBtn.addEventListener('click', async () => {
  const baseUrl = (els.baseUrlInput.value.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const token = els.tokenInput.value.trim();

  if (!token) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = 'Enter a token first';
    return;
  }

  els.settingsStatus.classList.remove('error');
  els.settingsStatus.textContent = 'Testing…';

  try {
    const me = await gitlabFetch(baseUrl, token, '/user');
    els.settingsStatus.textContent = `✓ Connected as ${me.name} (@${me.username})`;
  } catch (err) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = err.message || 'Connection failed';
  }
});

// ---------------------------------------------------------------------------
// Password validation & small UI helpers (show/hide, copy-to-clipboard —
// used so the password can be saved into 1Password manually; Chrome
// doesn't let one extension's content scripts reach into another
// extension's popup page, so there's no native autofill integration here).
// ---------------------------------------------------------------------------

const PASSWORD_ALLOWED_CHARS = /^[A-Za-z\d!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]+$/;
const PASSWORD_SPECIAL_CHAR = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]/;

function validatePassword(password) {
  if (password.length < 15) return 'Password must be at least 15 characters';
  if (!PASSWORD_ALLOWED_CHARS.test(password)) {
    return 'Only Latin letters, digits, and standard symbols are allowed';
  }
  if (!/[a-z]/.test(password)) return 'Include at least one lowercase letter';
  if (!/[A-Z]/.test(password)) return 'Include at least one uppercase letter';
  if (!/\d/.test(password)) return 'Include at least one digit';
  if (!PASSWORD_SPECIAL_CHAR.test(password)) return 'Include at least one special character';
  return null;
}

function attachShowPasswordCheckbox(checkbox, inputs) {
  checkbox.addEventListener('change', () => {
    const type = checkbox.checked ? 'text' : 'password';
    inputs.forEach((input) => {
      input.type = type;
    });
  });
}

function attachCopyButton(button, input, statusEl) {
  button.addEventListener('click', async () => {
    if (!input.value) return;
    try {
      await navigator.clipboard.writeText(input.value);
      statusEl.classList.remove('error');
      statusEl.textContent = 'Copied — paste it into 1Password now.';
    } catch {
      statusEl.classList.add('error');
      statusEl.textContent = 'Could not copy — select and copy manually.';
    }
    setTimeout(() => {
      statusEl.textContent = '';
    }, 3000);
  });
}

attachShowPasswordCheckbox(els.unlockShowCheckbox, [els.unlockPasswordInput]);
attachShowPasswordCheckbox(els.setupShowCheckbox, [
  els.setupPasswordInput,
  els.setupConfirmPasswordInput,
]);
attachShowPasswordCheckbox(els.newPinShowCheckbox, [els.newPinInput, els.confirmPinInput]);
attachCopyButton(els.setupCopyBtn, els.setupPasswordInput, els.setupCopyStatus);
attachCopyButton(els.newPinCopyBtn, els.newPinInput, els.changePinStatus);

els.setPinBtn.addEventListener('click', async () => {
  const password = els.newPinInput.value;
  const confirmPassword = els.confirmPinInput.value;

  const validationError = validatePassword(password);
  if (validationError) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = validationError;
    return;
  }
  if (password !== confirmPassword) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = 'Passwords do not match';
    return;
  }

  const settings = await getSettings();
  if (!settings.token) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = 'Unlock first before changing the password';
    return;
  }

  await rewrapWithPin(settings.token, password);
  chrome.runtime.sendMessage({ type: 'poll-now' });

  els.newPinInput.value = '';
  els.confirmPinInput.value = '';
  els.pinLockStatus.innerHTML = '<strong>Password lock: On</strong>';
  els.settingsStatus.classList.remove('error');
  els.settingsStatus.textContent = 'Password set';
  setTimeout(() => {
    els.settingsStatus.textContent = '';
  }, 1500);
});

els.enrollBiometricBtn.addEventListener('click', async () => {
  try {
    await enrollBiometric();
    els.biometricStatus.innerHTML = '<strong>Biometric unlock: On</strong>';
    els.enrollBiometricBtn.classList.add('hidden');
    els.removeBiometricBtn.classList.remove('hidden');
    els.settingsStatus.classList.remove('error');
    els.settingsStatus.textContent = 'Biometric unlock enabled';
  } catch (err) {
    els.settingsStatus.classList.add('error');
    els.settingsStatus.textContent = err.message || 'Could not enable biometric unlock';
  }
  setTimeout(() => {
    els.settingsStatus.textContent = '';
  }, 2000);
});

els.removeBiometricBtn.addEventListener('click', async () => {
  await removeBiometric();
  els.biometricStatus.innerHTML = '<strong>Biometric unlock: Off</strong>';
  els.enrollBiometricBtn.classList.remove('hidden');
  els.removeBiometricBtn.classList.add('hidden');
  els.settingsStatus.classList.remove('error');
  els.settingsStatus.textContent = 'Biometric unlock removed';
  setTimeout(() => {
    els.settingsStatus.textContent = '';
  }, 1500);
});

els.testSoundBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'test-sound', sound: els.soundChoiceSelect.value });
});

els.refreshBtn.addEventListener('click', () => loadDashboard());
els.searchInput.addEventListener('input', renderMrList);

[els.sortSelect, els.draftFilterSelect, els.staleFilterSelect, els.labelFilterSelect].forEach(
  (select) => {
    select.addEventListener('change', () => {
      saveUiState();
      renderMrList();
    });
  }
);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function proceedToApp(settings) {
  applyTheme(settings.theme);
  populateRepoSwitcher(settings.projectPaths, settings.activeProjectPath);

  const uiState = await loadUiState();
  if (uiState.uiSortValue) els.sortSelect.value = uiState.uiSortValue;
  if (uiState.uiDraftFilter) els.draftFilterSelect.value = uiState.uiDraftFilter;
  if (uiState.uiStaleFilter) els.staleFilterSelect.value = uiState.uiStaleFilter;
  if (uiState.uiLabelFilter) desiredLabelFilter = uiState.uiLabelFilter;
  if (uiState.uiActiveTab) activeAuthorUsername = uiState.uiActiveTab;
  setDashboardCollapsed(Boolean(uiState.uiDashboardCollapsed));

  const cached = await getCachedDashboard(settings.baseUrl, settings.activeProjectPath);
  if (cached) {
    currentUsername = cached.currentUsername;
    allMrs = cached.allMrs;
    computeAndRender();
    hideStatus();
    loadDashboard({ silent: true }); // refresh quietly behind the cached view
  } else {
    loadDashboard();
  }
}

// Shown once, only on a completely fresh install (this browser hasn't
// dismissed it before). Purely explanatory — "Get started" leads into the
// mandatory password screen, never straight into Settings: the password
// must exist before Settings (and the token it protects) becomes
// reachable at all.
function showWelcomeScreen() {
  els.appHeader.classList.add('hidden');
  els.welcomeScreen.classList.remove('hidden');
}

function hideWelcomeScreen() {
  els.welcomeScreen.classList.add('hidden');
  els.appHeader.classList.remove('hidden');
}

els.getStartedBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ welcomeSeen: true });
  hideWelcomeScreen();
  showPinSetupScreen();
});

async function showLockScreen() {
  els.appHeader.classList.add('hidden');
  els.lockScreen.classList.remove('hidden');

  const biometricEnrolled = await isBiometricEnrolled();
  els.biometricUnlockBtn.classList.toggle('hidden', !biometricEnrolled);
  els.biometricOrDivider.classList.toggle('hidden', !biometricEnrolled);

  els.unlockPasswordInput.focus();
}

function hideLockScreen() {
  els.lockScreen.classList.add('hidden');
  els.appHeader.classList.remove('hidden');
}

async function finishUnlock() {
  hideLockScreen();
  chrome.runtime.sendMessage({ type: 'poll-now' });
  await proceedToApp(await getSettings());
}

async function handleUnlock() {
  const password = els.unlockPasswordInput.value;
  if (!password) return;

  els.unlockError.classList.add('hidden');
  const token = await attemptUnlock(password);

  if (token === null) {
    els.unlockError.textContent = 'Incorrect password';
    els.unlockError.classList.remove('hidden');
    els.unlockPasswordInput.value = '';
    els.unlockPasswordInput.focus();
    return;
  }

  await finishUnlock();
}

async function handleBiometricUnlock() {
  els.unlockError.classList.add('hidden');
  const token = await attemptUnlockWithBiometric();
  if (token === null) {
    els.unlockError.textContent = 'Biometric unlock failed — use your password instead';
    els.unlockError.classList.remove('hidden');
    return;
  }
  await finishUnlock();
}

els.unlockBtn.addEventListener('click', handleUnlock);
els.unlockPasswordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handleUnlock();
});
els.biometricUnlockBtn.addEventListener('click', handleBiometricUnlock);

// A password is mandatory — this screen forces it right after the very
// first token save, and for anyone who somehow reaches this state without
// one. Biometric unlock is enrolled separately afterward, from Settings.
function showPinSetupScreen() {
  els.appHeader.classList.add('hidden');
  els.pinSetupScreen.classList.remove('hidden');
  els.setupPasswordInput.focus();
}

function hidePinSetupScreen() {
  els.pinSetupScreen.classList.add('hidden');
  els.appHeader.classList.remove('hidden');
}

async function handleSetupPin() {
  const password = els.setupPasswordInput.value;
  const confirmPassword = els.setupConfirmPasswordInput.value;

  els.setupPinError.classList.add('hidden');

  const validationError = validatePassword(password);
  if (validationError) {
    els.setupPinError.textContent = validationError;
    els.setupPinError.classList.remove('hidden');
    return;
  }
  if (password !== confirmPassword) {
    els.setupPinError.textContent = 'Passwords do not match';
    els.setupPinError.classList.remove('hidden');
    return;
  }

  // settings.token is usually '' here — the password is created before
  // GitLab is even configured (see showWelcomeScreen()'s comment above).
  const settings = await getSettings();
  await rewrapWithPin(settings.token, password);
  chrome.runtime.sendMessage({ type: 'poll-now' });

  els.setupPasswordInput.value = '';
  els.setupConfirmPasswordInput.value = '';
  hidePinSetupScreen();

  const updated = await getSettings();
  if (!updated.token) {
    await openSettingsPanel();
    showStatus('Set a repository and token in ⚙ Settings first.', false);
  } else {
    await proceedToApp(updated);
  }
}

els.setupPinBtn.addEventListener('click', handleSetupPin);
[els.setupPasswordInput, els.setupConfirmPasswordInput].forEach((input) => {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleSetupPin();
  });
});

(async function init() {
  const settings = await getSettings();

  if (settings.pinLockEnabled) {
    // Password already exists. "Unlocked" has to be checked independently
    // of whether a token exists yet — mid-onboarding (password set, GitLab
    // not configured yet) must not re-show the lock screen just because
    // settings.token happens to be empty.
    if (!(await isSessionUnlocked())) {
      await showLockScreen();
      return;
    }
  } else {
    // No password yet — required before Settings (and the token it
    // protects) becomes reachable at all, regardless of anything else.
    const { welcomeSeen } = await chrome.storage.local.get('welcomeSeen');
    if (!welcomeSeen) {
      showWelcomeScreen();
    } else {
      showPinSetupScreen();
    }
    return;
  }

  if (!settings.token) {
    await openSettingsPanel();
    showStatus('Set a repository and token in ⚙ Settings first.', false);
    return;
  }

  await proceedToApp(settings);
})();
