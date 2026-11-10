const MESSAGE = Buffer.from("Project trust").toString("base64");

/**
 * Pi reports every wait to Rex itself except its project-trust prompt. While that prompt is
 * open, this sends the report Pi would, so Rex shows it like any other wait. The run record,
 * not this report, decides what is waiting.
 */
export class TrustStatus {
  private reported = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly write: (sequence: string) => void;

  constructor(write: (sequence: string) => void) {
    this.write = write;
  }

  prompt(): void {
    clearTimeout(this.timer);
    // Trust observers also run for saved/default decisions. Give session_start time to clear it.
    this.timer = setTimeout(() => {
      if (this.reported) return;
      this.reported = true;
      this.write(`\x1b]7501;state=blocked:app=pi:kind=permission:msg=${MESSAGE}\x1b\\`);
    }, 500);
  }

  end(): void {
    clearTimeout(this.timer);
    if (!this.reported) return;
    this.reported = false;
    this.write("\x1b]7501;state=idle:app=pi\x1b\\");
  }
}
