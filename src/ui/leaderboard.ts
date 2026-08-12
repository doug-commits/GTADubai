/**
 * Per-branch leaderboard panel.
 *
 * Boards are scoped to a Love Mukbang branch — a fast run to DWTC is not the
 * same race as a fast run to JBR. DWTC is the default because that is the
 * branch the game drives to.
 *
 * All async work is sequence-guarded: a slow response for a branch the player
 * has already tabbed away from is dropped rather than painted.
 */

import {
  BRANCHES,
  type BranchId,
  type LeaderboardEntry,
  type RunResult,
  type UiHost,
} from '../contracts';

/** How many ranks the board shows, and therefore what "qualifying" means. */
const BOARD_SIZE = 10;
const MAX_NAME = 12;

export interface LeaderboardOptions {
  onTap?(): void;
  onNotice?(message: string): void;
}

export interface LeaderboardView {
  readonly el: HTMLElement;
  /** Open the panel. Pass the run just finished to enable name entry. */
  open(result?: RunResult | null): void;
  close(): void;
  isOpen(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatElapsed(seconds: number): string {
  const s = seconds > 0 ? seconds : 0;
  const tenths = Math.round(s * 10);
  const m = Math.floor(tenths / 600);
  const rem = tenths - m * 600;
  const ss = Math.floor(rem / 10);
  const t = rem - ss * 10;
  return m + ':' + (ss < 10 ? '0' : '') + ss + '.' + t;
}

/** Keep names short, printable and free of anything that could be markup. */
export function sanitiseName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\ufeff]/g, '')
    .replace(/[^\p{L}\p{N} '._-]/gu, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME)
    .trim();
}

const CLOSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
  '</svg>';

export function createLeaderboard(host: UiHost, opts: LeaderboardOptions = {}): LeaderboardView {
  const root = el('div', 'mkd-overlay mkd-leaderboard');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Leaderboard');

  const backdrop = el('div', 'ov-backdrop');
  const panel = el('div', 'ov-panel');
  panel.appendChild(el('div', 'ov-grip'));

  const head = el('div', 'ov-head');
  head.appendChild(el('div', 'ov-title', 'Leaderboard'));
  const closeBtn = el('button', 'ov-close mkd-hit');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close leaderboard');
  closeBtn.innerHTML = CLOSE_GLYPH;
  head.appendChild(closeBtn);
  panel.appendChild(head);

  // --- branch selector ----------------------------------------------------
  const tabs = el('div', 'lb-branches mkd-scroll');
  const tabNodes: HTMLButtonElement[] = [];
  for (let i = 0; i < BRANCHES.length; i++) {
    const b = BRANCHES[i]!;
    const btn = el('button', 'lb-branch mkd-hit', b.name);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      opts.onTap?.();
      select(b.id);
    });
    tabs.appendChild(btn);
    tabNodes.push(btn);
  }
  panel.appendChild(tabs);

  // --- body ---------------------------------------------------------------
  const bodyEl = el('div', 'ov-body mkd-scroll');

  // Name entry (only shown for a qualifying run on its own branch).
  const entry = el('div', 'lb-entry');
  entry.hidden = true;
  const entryTitle = el('div', 'le-title', 'You made the board — add your name');
  const entryRow = el('div', 'le-row');
  const nameInput = el('input', 'lb-input');
  nameInput.type = 'text';
  nameInput.maxLength = MAX_NAME;
  nameInput.placeholder = 'Your name';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.setAttribute('aria-label', 'Your name, up to 12 characters');
  const saveBtn = el('button', 'mkd-btn mkd-btn--gold mkd-hit le-save', 'Save');
  saveBtn.type = 'button';
  entryRow.appendChild(nameInput);
  entryRow.appendChild(saveBtn);
  entry.appendChild(entryTitle);
  entry.appendChild(entryRow);
  bodyEl.appendChild(entry);

  const msg = el('div', 'lb-msg');
  const rows = el('div', 'lb-rows');
  bodyEl.appendChild(msg);
  bodyEl.appendChild(rows);
  panel.appendChild(bodyEl);

  root.appendChild(backdrop);
  root.appendChild(panel);

  // --- state --------------------------------------------------------------
  let open = false;
  let branch: BranchId = 'dwtc';
  let pending: RunResult | null = null;
  let submitted = false;
  let seq = 0;
  let lastName = '';
  let mine: { name: string; elapsed: number } | null = null;

  function setTabs(): void {
    for (let i = 0; i < tabNodes.length; i++) {
      tabNodes[i]!.setAttribute('aria-pressed', BRANCHES[i]!.id === branch ? 'true' : 'false');
    }
  }

  function clearRows(): void {
    while (rows.firstChild) rows.removeChild(rows.firstChild);
  }

  function showMessage(text: string, spinner: boolean): void {
    clearRows();
    while (msg.firstChild) msg.removeChild(msg.firstChild);
    if (spinner) msg.appendChild(el('div', 'mkd-spinner'));
    msg.appendChild(document.createTextNode(text));
    msg.hidden = false;
  }

  function qualifies(list: LeaderboardEntry[], result: RunResult): boolean {
    if (list.length < BOARD_SIZE) return true;
    const cut = list[BOARD_SIZE - 1];
    return !cut || result.elapsed < cut.elapsed;
  }

  function paint(list: LeaderboardEntry[]): void {
    msg.hidden = true;
    while (msg.firstChild) msg.removeChild(msg.firstChild);
    clearRows();

    if (list.length === 0) {
      showMessage('No times on this board yet. Be the first to make the table.', false);
      return;
    }

    const shown = list.slice(0, BOARD_SIZE);
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i]!;
      const isYou =
        e.isYou === true ||
        (mine !== null && e.name === mine.name && Math.abs(e.elapsed - mine.elapsed) < 0.05);
      const row = el('div', 'lb-row' + (isYou ? ' is-you' : '') + (i < 3 ? ' is-podium' : ''));
      row.appendChild(el('div', 'r tnum', String(i + 1)));
      row.appendChild(el('div', 'n', e.name));
      row.appendChild(el('div', 't tnum', formatElapsed(e.elapsed)));
      row.appendChild(el('div', 's tnum', String(Math.round(e.score))));
      rows.appendChild(row);
    }
  }

  function updateEntryVisibility(list: LeaderboardEntry[] | null): void {
    const eligible =
      !submitted && pending !== null && pending.branch === branch && list !== null && qualifies(list, pending);
    entry.hidden = !eligible;
    if (eligible && lastName && !nameInput.value) nameInput.value = lastName;
  }

  function load(): void {
    const my = ++seq;
    entry.hidden = true;
    showMessage('Reading the board…', true);
    host.net.leaderboard(branch).then(
      (list) => {
        if (my !== seq || !open) return;
        const safe = Array.isArray(list) ? list.slice() : [];
        safe.sort((a, b) => a.elapsed - b.elapsed || b.score - a.score);
        paint(safe);
        updateEntryVisibility(safe);
      },
      () => {
        if (my !== seq || !open) return;
        showMessage("Couldn't load this board. Check your connection and tap the branch again.", false);
        updateEntryVisibility(null);
      },
    );
  }

  function select(next: BranchId): void {
    branch = next;
    setTabs();
    load();
  }

  function submit(): void {
    if (!pending || submitted) return;
    const name = sanitiseName(nameInput.value) || 'Racer';
    nameInput.value = name;
    lastName = name;
    saveBtn.setAttribute('disabled', 'true');
    nameInput.blur();
    const run = pending;
    host.net.submitScore(run, name).then(
      () => {
        submitted = true;
        mine = { name, elapsed: run.elapsed };
        saveBtn.removeAttribute('disabled');
        entry.hidden = true;
        opts.onNotice?.('Time saved');
        load();
      },
      () => {
        saveBtn.removeAttribute('disabled');
        opts.onNotice?.("Couldn't save your time");
      },
    );
  }

  function press(node: HTMLElement, fn: () => void): void {
    node.addEventListener('click', (ev) => {
      ev.preventDefault();
      opts.onTap?.();
      fn();
    });
  }

  press(closeBtn, () => api.close());
  press(backdrop, () => api.close());
  press(saveBtn, submit);

  nameInput.addEventListener('input', () => {
    const clean = sanitiseName(nameInput.value);
    if (clean !== nameInput.value) nameInput.value = clean;
  });
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  setTabs();

  const api: LeaderboardView = {
    el: root,

    open(result) {
      const fresh = result ?? null;
      if (fresh) {
        // A new run resets submission state and jumps to that run's branch.
        if (pending === null || pending !== fresh) submitted = false;
        pending = fresh;
        branch = fresh.branch;
      } else {
        pending = null;
      }
      open = true;
      root.classList.add('is-on');
      setTabs();
      load();
    },

    close() {
      if (!open) return;
      open = false;
      seq++;
      root.classList.remove('is-on');
    },

    isOpen() {
      return open;
    },
  };

  return api;
}
