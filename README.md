# GitLab MR Dashboard (Chrome extension)

Dashboard for your GitLab merge requests across one or more projects on the
same GitLab instance: stats, per-author tabs, filters, labels, themes, and
desktop notifications (with sound) — even while the popup is closed.

## Setup

1. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon. On a fresh install you'll land on a **Welcome screen** first — click **Get started**.
3. You'll be asked to **create a password** before anything else — Settings isn't reachable until this is done (see "Password lock" below). 15+ characters, with the required mix of upper/lower/digit/symbol.
4. That leads straight into Settings → **General**: fill in
   - **GitLab base URL**: `https://gitlab.strictweb.com` (default)
   - **Personal access token**: create one at `https://gitlab.strictweb.com/-/user_settings/personal_access_tokens` with the `read_api` scope (the `?` icon and the link under the field jump you there directly) — **Test connection** verifies it before you save
   - **Username**: optional, auto-detected from the token via `/api/v4/user`
   - **Repositories**: add one or more `namespace/project` paths (e.g. `applications/frontend/pa`) — each becomes a repo in the header switcher
5. Save. The popup loads the active repo's open MRs and refreshes on demand (⟳).

## Popup

- If this browser session hasn't been unlocked yet (every full Chrome restart), the popup shows a lock screen (password, or biometric if enrolled) instead of everything else — see "Password lock" under Token security. First-time setup forces you to create a password right after saving the token, before the dashboard is reachable.
- **One screen at a time**: opening Settings or the Info panel (ℹ) hides the dashboard and MR list entirely behind it rather than stacking on top — closing either brings the dashboard straight back to whatever it was showing.
- Settings itself is split into four tabs — **General** (connection + repositories), **Notifications** (polling interval, per-event toggles, sound), **Appearance** (theme), **Security** (password + biometric) — instead of one long scrolling form.
- Header: a **repo switcher** (when more than one repository is configured), **↗** opens the current repo's MR list on GitLab, **⟳** refreshes, **⌃/⌄** collapses/expands just the stats blocks (both stat grids) — the search box, filters, tabs, and MR list stay visible — remembered across reopens, **ℹ** shows a short in-extension description of what this is, **⚙** opens settings.
- Top stats: total open / approved / failed / awaiting approval for the active repo, plus your own MRs (total / approved / not approved) and **Needs my review**.
- **Merge requests by author** — tabs: **All**, **Needs review**, **Needs my review**, then one per author (yours is "Me", pinned first, with avatar). Each item shows:
  - a status dot (green = approved, amber = pending, red = failed)
  - status pills: **Draft**, **CI failed**, **Conflicts**, **Untouched** (zero comments and zero approvals, drafts excluded)
  - its GitLab labels, as colored chips
  - relative `Created` / `Last commit` dates (hover for the exact date)
  - an approval progress line (`x/y approvals — names`) whenever the MR has an approval rule
  - an unresolved-discussion-threads count, when non-zero
- A **search box** filters by title or `!123`. **Drafts** and **Stale (>1mo)** filters (each: all / hide / only), a **label** filter, and the **sort** dropdown act on the current tab. Search resets each time you open the popup; the other filters, sort, active tab, and collapsed state persist.
- Click any MR to open it in a background tab — the popup stays open so you can open several in a row.
- Opening the popup (or switching repos) renders instantly from that repo's cached snapshot, then quietly refetches in the background and re-renders when new data arrives.

## Multiple repositories

Add as many `namespace/project` paths as you want in Settings → Repositories (all on the one configured GitLab instance/token). The header switcher jumps between them, each with its own cache, tabs, and filters. The background poller and the toolbar badge cover **every configured repo at once** — you don't have to have a repo open in the popup for it to be monitored. Notifications are tagged with the repo's last path segment, e.g. `New MR !42 (pa)`.

## Toolbar badge

Aggregated across all configured repos, refreshed only by the background poller (the popup no longer touches it — a single global number, whichever repo you happen to be looking at):

- **Red** — total MRs across all repos where you're a requested reviewer and haven't approved (**Needs my review**).
- **Amber** — shown only when there's no red: total MRs across all repos that are blocked on nothing but an approval (**Needs review** — no unresolved threads, short of the required approval count; doesn't matter whose approval).
- **Red "!"** — the background poll has failed 3 times in a row (bad token, network, rate limit, etc.); hover the icon for the error message.

## Notifications

A service worker polls every configured repo on the interval you set in **Settings → Polling** (2/5/10/15/30 minutes; default 5 — short enough to stay timely, long enough that a handful of repos won't hammer the API) via `chrome.alarms`, so it runs even with the popup closed. Each notification type can be toggled independently in **Settings → Notifications** (all on by default):

- new (non-draft) MR opened
- new commits pushed to an existing, non-draft MR
- an MR switching from **Draft** to ready-for-review
- an MR getting approved
- an MR being merged
- **pipeline failing on your own MR** — not sent for MRs you merely review
- **a new merge conflict appearing on your own MR** — same, author-only

Draft MRs stay silent on creation, new commits, pipeline failures, and new
conflicts — only the draft → ready transition notifies. Clicking a
notification opens the MR. Saving settings (adding a repo, changing the
token, etc.) triggers an immediate poll instead of waiting for the next
interval. The first poll for a given repo only takes a snapshot — no
notification backlog is fired retroactively.

**Sound**: toggle on/off in Settings, with a choice of sounds and a **Test**
button — three short generated tones (Chime / Ding / Pop, `.wav`) plus a
set of longer sampled sounds (`.mp3`: notification ping/effect, two "new
notification" variants, funny alarm, car horn/engine, dog bark, surprise,
warning, scary scream). Each option's value is the exact filename under
`sounds/`, so adding another one is just: drop the file in `sounds/` and
add a matching `<option>` in `popup.html`'s `soundChoiceSelect` — no other
code change needed. Playback goes through a short-lived offscreen document
(`offscreen.html`), since the service worker itself has no `<audio>`.

## Appearance

**Settings → Appearance → Theme**: Match system (default), Light, Dark,
Solarized, Dracula, or Nord.

## Reliability

- Every GitLab API call times out after 15s and surfaces a clear error instead of hanging the popup on "Loading…" forever.
- Hitting GitLab's rate limit (`429`) is detected and surfaces the `Retry-After` value in the error message.
- Per-MR follow-up requests (approvals, commit, discussions) run at a concurrency cap of 6 in flight, not all-at-once, to avoid triggering that rate limit on projects with many open MRs — this matters more now that polling loops over every configured repo each cycle.

## Definitions

- **Failed** (status dot) — pipeline status is `failed` (pill: **CI failed**) or the MR has merge conflicts (pill: **Conflicts**); either can be true independently.
- **Draft** — GitLab's `draft` / `work_in_progress` flag, or a `Draft:`/`WIP:` title prefix as a fallback for older GitLab versions.
- **Approved** — GitLab's `approvals.approved` flag for the MR.
- **Untouched** (per-MR pill) — `user_notes_count === 0` and no approvals yet, and not a draft.
- **Needs review** (tab/badge) — not a draft, zero unresolved discussion threads, and fewer approvals than the rule requires. Approver identity doesn't matter.
- **Needs my review** (tab/stat/badge) — you're listed in `reviewers`, you haven't approved, and you're not the author.
- **Unresolved threads** — discussions with at least one resolvable, unresolved note.
- **Awaiting approval** — open MRs not yet approved.

## Token security

The token is AES-GCM encrypted at rest. Unlike a naive "key sitting next to
the ciphertext" scheme, the encryption key itself is never stored:

1. A random AES-256 **data key** encrypts the token.
2. The data key is wrapped (encrypted) with a **wrapping key**, derived via
   PBKDF2 (100k iterations) from a fingerprint of this browser/device plus a
   random, non-secret salt. The fingerprint mixes software/locale signals
   (`navigator.userAgent`, `platform`, `language`, `hardwareConcurrency`,
   IANA time zone, this extension's install ID) with genuinely
   hardware-specific ones pulled from User-Agent Client Hints where the
   browser exposes them — CPU **architecture** and **bitness**, device
   **model**, and OS **platform version**. Every component has to exist
   identically in both the popup and the background service worker (one
   encrypts, the other decrypts), which is why signals that are Window-only
   by spec (`screen.*`, `navigator.deviceMemory`) are deliberately left out
   — including them would make the two contexts derive different keys and
   silently "lose" the token.
3. `chrome.storage.local` only ever holds: the wrapped data key, the salt,
   and the encrypted token. The wrapping key and the plaintext data key are
   never persisted anywhere — they're recomputed on demand (and cached in
   memory for the current popup session / service-worker wake-up only).

This needs no passphrase and no prompt — the fingerprint is recomputed
transparently, which is also what lets the background poller decrypt the
token unattended every cycle (a real biometric/passphrase gate was
considered, but `navigator.credentials`/WebAuthn isn't available to a
service worker, so it can't gate unattended background polling — see the
project history for that tradeoff).

**What this defends against**: copying the raw `chrome.storage.local` blob
to another machine, profile, or a reinstalled copy of the extension — the
fingerprint won't reproduce, so it won't decrypt. **What it does not
defend against**: someone who already runs code inside this exact Chrome
profile — they can recompute the same fingerprint just as easily as the
extension does. It's stored in `chrome.storage.local`, not `sync`, so it's
never transmitted to Google's sync servers either.

**Decoy entries**: alongside the real `tokenWrappedKey`/`tokenEncrypted`,
a handful of plausible-looking, entirely unused entries
(`tokenWrappedKeyLegacy`, `tokenBackupKey`, `authCacheKey`,
`sessionSeedKey` — random bytes shaped like real `{iv, ciphertext}` blobs)
get written to
`chrome.storage.local` too, regenerated whenever the real ones are. This
is pure noise, not cryptography — anyone reading the source instantly
sees which keys are real; it only slows down someone manually skimming
raw storage output without the source in front of them.

### Password lock (required, min. 15 characters)

A password is mandatory — the popup forces a "Set a password to continue"
screen immediately after the first token save, before the dashboard is
reachable at all, and there's no setting to turn it back off (Settings →
Lock only offers **Change password**). Requirements: **15+ characters**,
Latin letters/digits/standard symbols only, with **at least one uppercase
letter, one lowercase letter, one digit, and one special character**.

Setting it mixes the password directly into the same key derivation
described above — the wrapping key becomes `PBKDF2(fingerprint + password,
salt)` instead of `PBKDF2(fingerprint, salt)`. This is real key material,
not a pass/fail check bolted on the side: get the password wrong and
AES-GCM's authentication tag simply fails to verify, so there is no key to
fall back to and nothing short of the correct password will ever unwrap it.

Because the password only exists in the popup's memory for the moment it's
typed, and a service worker can't show a prompt, the background poller
can't derive this on its own. Instead, a correct unlock caches **only the
now-unwrapped raw data key** — never the plaintext token itself — in
`chrome.storage.session` (memory-only, wiped when Chrome fully closes).
The token stays exclusively in its AES-GCM-encrypted form in
`chrome.storage.local` at all times; the background poller and any later
popup open, same browser session, decrypt it fresh from that cached key
every time they need it (`decryptTokenWithSessionKey()`), rather than
reading a stored plaintext copy. Practically:

- **Every full Chrome restart**: the popup shows a lock screen before it
  reads the token at all; the background poller pauses (badge shows 🔒)
  until you unlock. The background service worker also tries to auto-open
  the popup once per browser session as soon as it notices it's locked
  (on browser startup, or on the first poll after that) via
  `chrome.action.openPopup()`, so you don't have to remember to click the
  icon. That API has real Chrome-version/window-focus restrictions and can
  silently fail outside a genuine user gesture — when it does, a
  notification ("GitLab MR Dashboard is locked") appears instead; clicking
  it retries the open from within a real click, which is far more likely
  to succeed.
- **For the rest of that browser session**: fully unattended again.

This is a genuinely stronger guarantee than fingerprint-only wrapping
would be on its own: `chrome.storage.local` — even freshly after a browser
restart, even to someone who can run code in this exact profile — is
cryptographically insufficient to recover the token without the password.
The trust boundary moves to whatever already has access to an *unlocked*
session (i.e. `chrome.storage.session` while it holds `unlockedToken`),
same as any password manager that's been unlocked for the browser session.

The password itself is never written anywhere — not hashed, not stored —
only ever used transiently to derive a key.

### Biometric unlock (optional, on top of the password)

Settings → Lock → **Enable Touch ID / Windows Hello**, shown only when
`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`
reports a platform authenticator. This uses WebAuthn's **PRF extension** —
not a plain "did the user verify" assertion, which only proves presence
and isn't usable as key material. PRF returns a stable, high-entropy
secret computed *inside* the authenticator's secure hardware (Secure
Enclave / TPM) from the credential plus a fixed, non-secret salt. That
secret is imported directly as an AES-GCM key (no PBKDF2 needed — it's
already 32 bytes of real entropy, not a guessable password) and wraps a
second copy of the *same* data key the password wraps. Either unlock path
decrypts the identical token.

The password remains mandatory and is never removable — biometric is
strictly additional, for when the same device/browser/OS combo supports
it. On the lock screen, if enrolled, a "🖐 Use Touch ID / Windows Hello"
button appears above the password field. Changing the password re-wraps
the biometric copy too (one extra biometric prompt at that moment) so both
stay in sync; removing biometric unlock just deletes its wrapped copy and
credential ID — the password-wrapped copy is untouched.

**Caveats worth knowing**: PRF support varies by Chrome version, OS, and
authenticator — feature-detected at enrollment time
(`credential.getClientExtensionResults().prf.enabled`), with a clear error
if unsupported. Like
everything else here, `navigator.credentials` only exists in the popup
(a `Window`), never in the service worker — background polling always
goes through the session cache either way, exactly like the password path.

### Saving the password in 1Password

There's no native integration, and there can't really be one: Chrome
doesn't let one extension's content scripts inject UI into another
extension's popup page, so 1Password's autofill icon will never appear
inside this popup, no matter what markup or `autocomplete` attributes are
used here. That's a platform boundary, not a missing feature.

The practical workaround, built into the setup and change-password
screens: a "Show password" checkbox to reveal what you typed, and a "Copy
password" button that copies the current field to the clipboard via
`navigator.clipboard.writeText()`. Copy it, go create a new Login or
Secure Note in 1Password yourself, paste it in there, and save. After
every full Chrome restart, retrieve it from 1Password and paste it into
the lock screen the same way — or use biometric unlock instead, if
enrolled, and skip the copy-paste entirely.

## Notes

- To point at a different GitLab instance, change the base URL — all cached/tracked state resets automatically since MR IDs from the old instance are meaningless against the new one. Adding/removing individual repos on the *same* instance needs no reset; a newly added repo just bootstraps silently on its first poll.
- No multi-account / multi-instance support — one GitLab base URL and token, any number of repos on it.
- Not yet exercised against a live GitLab instance/token — verify field names (`reviewers`, `user_notes_count`, `pipeline`, `discussions`) still match your GitLab version if something looks off, and use **Test connection** first.
