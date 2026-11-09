/** A notice is advisory terminal output, never a replacement for the run's waiting record. */
export class AttentionNotices {
  private waiting = false;
  private trustTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly label: string;
  private readonly write: (sequence: string) => void;

  constructor(label: string, write: (sequence: string) => void) {
    this.label = label;
    this.write = write;
  }

  trust(): void {
    clearTimeout(this.trustTimer);
    // Trust observers also run for saved/default decisions. Give session_start time to clear it.
    this.trustTimer = setTimeout(() => this.start("Project trust"), 500);
  }

  start(title: string): void {
    if (this.waiting) return;
    this.waiting = true;
    const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 200);
    this.write(`\x1b]9;Subagent ${safe(this.label)}: ${safe(title)}\x07`);
  }

  end(): void {
    clearTimeout(this.trustTimer);
    this.waiting = false;
  }
}
