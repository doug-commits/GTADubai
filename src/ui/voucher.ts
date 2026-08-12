/**
 * Voucher — renders the server-issued discount code and prints it.
 *
 * ============================ CRITICAL RULE ============================
 * The game must NEVER generate, derive, guess, cache-substitute or
 * placeholder a voucher code. Every character rendered here comes straight
 * out of the `VoucherResponse` returned by `host.net.claimVoucher()`. If the
 * call rejects we show an honest error plus a Retry button and render NO
 * code at all. There is deliberately no code-generating function in this
 * file, and there must never be one.
 * ======================================================================
 *
 * Printing: the dark game UI must never end up on paper. We mirror the
 * ticket into a `.mkd-printsheet` element mounted as a direct child of
 * <body>; `@media print` in styles.css blanks every other body child and
 * reveals that sheet as clean black-on-white.
 */

import { BRANCHES, type BranchId, type VoucherResponse, type VoucherState } from '../contracts';

const TERMS =
  'One voucher per table, dine-in only at the branch shown. Present this code to your server ' +
  'before ordering. Cannot be combined with other offers or set menus. Non-transferable, no cash ' +
  'value. Love Mukbang reserves the right to withdraw this promotion at any time.';

export interface VoucherOptions {
  /** Fired when the player taps Retry after a failed claim. */
  onRetry(): void;
  /** Fired on every press, so the shell can play the UI tap. */
  onTap?(): void;
  /** Fired with a short message the shell should toast. */
  onNotice?(message: string): void;
}

export interface VoucherView {
  /** Mount this inside the win screen. */
  readonly el: HTMLElement;
  /** Re-render for the given state. Safe to call repeatedly. */
  render(state: VoucherState, branch: BranchId): void;
  /** Build the print sheet from the last OK state and open the print dialog. */
  print(): void;
  /** Remove the body-level print sheet. */
  dispose(): void;
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

function branchName(id: BranchId): string {
  for (let i = 0; i < BRANCHES.length; i++) {
    if (BRANCHES[i]!.id === id) return BRANCHES[i]!.name;
  }
  return 'Love Mukbang';
}

export function createVoucher(opts: VoucherOptions): VoucherView {
  const root = el('div', 'mkd-voucher-slot');

  // --- loading state ------------------------------------------------------
  const loading = el('div', 'mkd-vstate');
  loading.appendChild(el('div', 'mkd-spinner'));
  const loadCopy = el('div', 'vs-copy');
  loadCopy.appendChild(el('div', 'vs-title', 'Firing up your voucher'));
  loadCopy.appendChild(
    el('div', 'vs-note', 'Asking the kitchen for a one-time code. This takes a second.'),
  );
  loading.appendChild(loadCopy);

  // --- error state --------------------------------------------------------
  const errorBox = el('div', 'mkd-vstate mkd-vstate--error');
  const errCopy = el('div', 'vs-copy');
  const errTitle = el('div', 'vs-title', 'Voucher unavailable');
  const errNote = el('div', 'vs-note', '');
  errCopy.appendChild(errTitle);
  errCopy.appendChild(errNote);
  errorBox.appendChild(errCopy);
  const retryBtn = el('button', 'mkd-btn mkd-btn--ghost mkd-hit vs-retry', 'Retry');
  retryBtn.type = 'button';
  errorBox.appendChild(retryBtn);

  // --- issued ticket ------------------------------------------------------
  const ticket = el('div', 'mkd-ticket');

  const head = el('div', 'tk-head');
  const brand = el('div', 'tk-brand');
  brand.appendChild(document.createTextNode('Love Mukbang'));
  const brandSub = el('span', undefined, 'Korean BBQ');
  brand.appendChild(brandSub);
  head.appendChild(brand);
  const off = el('div', 'tk-off');
  const offN = el('div', 'n', '');
  const offL = el('div', 'l', 'Off your table');
  off.appendChild(offN);
  off.appendChild(offL);
  head.appendChild(off);
  ticket.appendChild(head);

  const body = el('div', 'tk-body');
  const codeWrap = el('div', 'tk-codewrap');
  codeWrap.appendChild(el('div', 'tk-codecap', 'Your code'));
  const codeEl = el('div', 'tk-code tnum', '');
  codeWrap.appendChild(codeEl);
  body.appendChild(codeWrap);

  const meta = el('div', 'tk-meta');
  const metaBranch = el('div');
  metaBranch.appendChild(document.createTextNode('Branch '));
  const metaBranchV = el('b', undefined, '');
  metaBranch.appendChild(metaBranchV);
  const metaExp = el('div');
  metaExp.appendChild(document.createTextNode('Valid until '));
  const metaExpV = el('b', undefined, '');
  metaExp.appendChild(metaExpV);
  const metaId = el('div');
  metaId.appendChild(document.createTextNode('Ref '));
  const metaIdV = el('b', undefined, '');
  metaId.appendChild(metaIdV);
  meta.appendChild(metaBranch);
  meta.appendChild(metaExp);
  meta.appendChild(metaId);
  body.appendChild(meta);

  body.appendChild(el('div', 'tk-terms', TERMS));

  const actions = el('div', 'tk-actions');
  const printBtn = el('button', 'mkd-btn mkd-btn--gold mkd-hit', 'Print voucher');
  printBtn.type = 'button';
  const copyBtn = el('button', 'mkd-btn mkd-btn--ghost mkd-hit', 'Copy code');
  copyBtn.type = 'button';
  actions.appendChild(printBtn);
  actions.appendChild(copyBtn);
  body.appendChild(actions);

  ticket.appendChild(body);

  const idle = el('div', 'mkd-vstate');
  const idleCopy = el('div', 'vs-copy');
  idleCopy.appendChild(el('div', 'vs-title', 'Voucher'));
  idleCopy.appendChild(el('div', 'vs-note', 'Finish a run to unlock a table discount.'));
  idle.appendChild(idleCopy);

  root.appendChild(idle);
  root.appendChild(loading);
  root.appendChild(errorBox);
  root.appendChild(ticket);

  // --- print sheet (direct child of <body>, hidden until @media print) -----
  const sheet = el('div', 'mkd-printsheet');
  const pvTicket = el('div', 'pv-ticket');
  const pvHead = el('div', 'pv-head');
  const pvBrand = el('div', 'pv-brand');
  pvBrand.appendChild(document.createTextNode('Love Mukbang'));
  pvBrand.appendChild(el('span', undefined, 'Korean BBQ · Halal · UAE'));
  pvHead.appendChild(pvBrand);
  const pvOff = el('div', 'pv-off');
  const pvOffN = el('div', 'n', '');
  pvOff.appendChild(pvOffN);
  pvOff.appendChild(el('div', 'l', 'Off your table'));
  pvHead.appendChild(pvOff);
  pvTicket.appendChild(pvHead);

  const pvCodeWrap = el('div', 'pv-codewrap');
  pvCodeWrap.appendChild(el('div', 'pv-codecap', 'Voucher code'));
  const pvCode = el('div', 'pv-code', '');
  pvCodeWrap.appendChild(pvCode);
  pvTicket.appendChild(pvCodeWrap);

  const pvMeta = el('div', 'pv-meta');
  const pvBranch = el('div');
  pvBranch.appendChild(document.createTextNode('Branch: '));
  const pvBranchV = el('b', undefined, '');
  pvBranch.appendChild(pvBranchV);
  const pvExp = el('div');
  pvExp.appendChild(document.createTextNode('Valid until: '));
  const pvExpV = el('b', undefined, '');
  pvExp.appendChild(pvExpV);
  const pvRef = el('div');
  pvRef.appendChild(document.createTextNode('Ref: '));
  const pvRefV = el('b', undefined, '');
  pvRef.appendChild(pvRefV);
  pvMeta.appendChild(pvBranch);
  pvMeta.appendChild(pvExp);
  pvMeta.appendChild(pvRef);
  pvTicket.appendChild(pvMeta);

  pvTicket.appendChild(el('div', 'pv-terms', TERMS));
  sheet.appendChild(pvTicket);
  document.body.appendChild(sheet);

  let issued: VoucherResponse | null = null;
  let issuedBranch: BranchId | null = null;

  function press(node: HTMLElement, fn: () => void): void {
    node.addEventListener('click', (ev) => {
      ev.preventDefault();
      opts.onTap?.();
      fn();
    });
  }

  press(retryBtn, () => opts.onRetry());
  press(printBtn, () => api.print());
  press(copyBtn, () => {
    // Copies the SERVER-issued string only.
    const code = issued?.code;
    if (!code) return;
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
    const write = nav.clipboard?.writeText(code);
    if (write) {
      write.then(
        () => opts.onNotice?.('Code copied'),
        () => opts.onNotice?.('Copy failed — write it down'),
      );
    } else {
      opts.onNotice?.('Copy failed — write it down');
    }
  });

  function show(which: 'idle' | 'loading' | 'error' | 'ok'): void {
    idle.hidden = which !== 'idle';
    loading.hidden = which !== 'loading';
    errorBox.hidden = which !== 'error';
    ticket.hidden = which !== 'ok';
  }

  show('idle');

  function paint(v: VoucherResponse, branch: BranchId): void {
    const name = branchName(branch);

    // Discount: rendered only when the server supplied one.
    const hasPct = typeof v.discountPercent === 'number' && isFinite(v.discountPercent);
    const pct = hasPct ? String(Math.round(v.discountPercent as number)) + '%' : 'GIFT';
    offN.textContent = pct;
    pvOffN.textContent = pct;
    offL.textContent = hasPct ? 'Off your table' : 'From the kitchen';

    // The code — straight from the server response, never synthesised.
    codeEl.textContent = v.code;
    pvCode.textContent = v.code;

    metaBranchV.textContent = name;
    pvBranchV.textContent = name;

    const hasExp = typeof v.expires === 'string' && v.expires.length > 0;
    metaExp.hidden = !hasExp;
    pvExp.hidden = !hasExp;
    if (hasExp) {
      metaExpV.textContent = v.expires as string;
      pvExpV.textContent = v.expires as string;
    }

    const hasId = typeof v.voucherId === 'string' && v.voucherId.length > 0;
    metaId.hidden = !hasId;
    pvRef.hidden = !hasId;
    if (hasId) {
      metaIdV.textContent = v.voucherId as string;
      pvRefV.textContent = v.voucherId as string;
    }
  }

  const api: VoucherView = {
    el: root,

    render(state, branch) {
      if (state.status === 'ok') {
        issued = state.voucher;
        issuedBranch = branch;
        paint(state.voucher, branch);
        show('ok');
        return;
      }

      issued = null;
      issuedBranch = null;
      // Blank the print sheet so a stale code can never reach paper.
      pvCode.textContent = '';
      pvOffN.textContent = '';

      if (state.status === 'loading') {
        show('loading');
      } else if (state.status === 'error') {
        errNote.textContent =
          (state.message && state.message.trim().length > 0
            ? state.message.trim()
            : "We couldn't reach the voucher desk.") +
          ' No code has been issued — tap retry and we will ask again.';
        show('error');
      } else {
        show('idle');
      }
    },

    print() {
      if (!issued || !issuedBranch) {
        opts.onNotice?.('No voucher to print yet');
        return;
      }
      paint(issued, issuedBranch);
      // Give the sheet one frame to lay out before the modal print dialog.
      requestAnimationFrame(() => {
        try {
          window.print();
        } catch {
          opts.onNotice?.('Printing is blocked on this device');
        }
      });
    },

    dispose() {
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
    },
  };

  return api;
}
