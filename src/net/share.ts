/**
 * Share sheet for a finished run.
 *
 * Three tiers, in order of how good they feel:
 *   1. `navigator.share` — the real OS sheet (WhatsApp, Instagram, AirDrop).
 *   2. `navigator.clipboard.writeText` — silent copy, UI says "copied".
 *   3. hidden textarea + `document.execCommand('copy')` — older iOS Safari.
 *
 * A user who opens the sheet and dismisses it has NOT failed: that resolves
 * `'cancelled'` so the UI can stay quiet instead of flashing an error. A real
 * failure (no share, no clipboard, no execCommand) rejects.
 */

import type { BranchId, RunResult } from '../contracts';

export type ShareOutcome = 'shared' | 'copied' | 'cancelled';

/** Short, punchy branch labels for the share line — "Love Mukbang DWTC". */
const BRANCH_LABEL: Record<BranchId, string> = {
  dwtc: 'DWTC',
  jbr: 'JBR',
  deira: 'Deira',
  muroor: 'Muroor',
  electra: 'Electra',
};

const SHARE_TITLE = 'Mukbang Dash';

/** `M:SS.s` — 107.32 -> "1:47.3". */
export function formatRunTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const tenths = Math.round(safe * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  const secs = Math.floor(rest / 10);
  const tenth = rest % 10;
  return `${minutes}:${String(secs).padStart(2, '0')}.${tenth}`;
}

/** Sub-minute margins read better as "12.4s"; anything longer uses `M:SS.s`. */
export function formatSpare(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return safe < 60 ? `${(Math.round(safe * 10) / 10).toFixed(1)}s` : formatRunTime(safe);
}

function formatScore(score: number): string {
  const safe = Number.isFinite(score) ? Math.round(score) : 0;
  return safe.toLocaleString('en-US');
}

/**
 * Canonical share link. Query and hash are dropped so a shared URL is the game,
 * not whatever debug flags the player happened to have on.
 */
function defaultShareUrl(): string {
  if (typeof location === 'undefined') return '';
  const origin = location.origin;
  if (!/^https?:$/i.test(location.protocol)) return ''; // file:// preview — nothing worth sharing
  return `${origin}${location.pathname}`;
}

export interface ShareMessage {
  title: string;
  /** Never contains the URL — native sheets take the url separately. */
  text: string;
  /** Empty when there is nothing meaningful to link to. */
  url: string;
}

/**
 * Compose the brag.
 *
 *   "I made it to Love Mukbang DWTC in 1:47.3 with 12.4s to spare —
 *    41,200 pts. Beat me:"
 */
export function buildShareMessage(result: RunResult, url: string = defaultShareUrl()): ShareMessage {
  const branch = BRANCH_LABEL[result.branch] ?? String(result.branch).toUpperCase();
  const elapsed = formatRunTime(result.elapsed);
  const score = formatScore(result.score);
  const spare = Math.max(0, result.timeRemaining);

  const opener =
    spare < 0.1
      ? `I made it to Love Mukbang ${branch} in ${elapsed} with the clock on zero — ${score} pts.`
      : `I made it to Love Mukbang ${branch} in ${elapsed} with ${formatSpare(spare)} to spare — ${score} pts.`;

  return { title: SHARE_TITLE, text: url ? `${opener} Beat me:` : opener, url };
}

/** A dismissed share sheet, not a broken one. */
function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

async function copyToClipboard(payload: string): Promise<boolean> {
  const clipboard: Clipboard | undefined =
    typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(payload);
      return true;
    } catch {
      // Insecure context, no permission, or not focused — drop to the legacy path.
    }
  }
  return legacyCopy(payload);
}

/** Hidden textarea + execCommand. Deprecated everywhere, still the only path on old iOS. */
function legacyCopy(payload: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  const ta = document.createElement('textarea');
  ta.value = payload;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  ta.style.fontSize = '16px'; // < 16px makes iOS zoom the viewport on focus

  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, payload.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
  }
  return ok;
}

/**
 * Share a finished run.
 *
 * @returns `'shared'` via the OS sheet, `'copied'` when it landed on the
 *          clipboard instead, `'cancelled'` when the player dismissed the
 *          sheet. Rejects only when nothing worked at all.
 */
export async function shareRun(
  result: RunResult,
  opts?: { url?: string },
): Promise<'shared' | 'copied' | 'cancelled'> {
  const message = buildShareMessage(result, opts?.url ?? defaultShareUrl());
  const data: ShareData = message.url
    ? { title: message.title, text: message.text, url: message.url }
    : { title: message.title, text: message.text };

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const shareable = typeof navigator.canShare === 'function' ? navigator.canShare(data) : true;
    if (shareable) {
      try {
        await navigator.share(data);
        return 'shared';
      } catch (err: unknown) {
        // The player closed the sheet — that is a choice, not an error.
        if (isAbort(err)) return 'cancelled';
        // Anything else (missing gesture, unsupported target) falls through to copy.
      }
    }
  }

  const payload = message.url ? `${message.text} ${message.url}` : message.text;
  if (await copyToClipboard(payload)) return 'copied';

  throw new Error('Could not open the share sheet or copy the link on this device.');
}
