/*
 * History GC abstraction (#20 in INSTRUCTION.md).
 *
 * Current XAL exposes no official model-facing conversation transform hook
 * that can rewrite `StreamRequest.input`, so v1 ships NoopHistoryGcAdapter.
 * If a future public XAL version adds an official conversation transform,
 * PublicHistoryGcAdapter may be implemented — never by patching core.
 */

export interface ConversationItemShim {
  type: string;
  [key: string]: unknown;
}

export interface HistoryGcContext {
  sessionId: string;
}

export interface HistoryGcAdapter {
  supported(): boolean;
  transform(
    input: ConversationItemShim[],
    context: HistoryGcContext,
  ): ConversationItemShim[];
}

/** v1: no historical sweep. Ingress paging happens at hook time instead. */
export class NoopHistoryGcAdapter implements HistoryGcAdapter {
  supported(): boolean {
    return false;
  }

  transform(
    input: ConversationItemShim[],
    _context: HistoryGcContext,
  ): ConversationItemShim[] {
    return input;
  }
}
