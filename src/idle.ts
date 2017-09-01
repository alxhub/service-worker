import {Adapter} from './adapter';

export type IdleTask = () => Promise<void>;

interface ScheduledRun {
  cancel: boolean;
}

export class IdleScheduler {
  private queue: IdleTask[] = [];
  private scheduled: ScheduledRun|null = null;
  empty: Promise<void> = Promise.resolve();
  private emptyResolve: Function|null = null;

  constructor(private adapter: Adapter, private threshold: number) {}

  async trigger(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    if (this.scheduled !== null) {
      this.scheduled.cancel = true;
    }

    this.scheduled = {
      cancel: false,
    };

    await this.adapter.timeout(this.threshold);

    if (this.scheduled.cancel) {
      this.scheduled = null;
      return;
    }

    this.scheduled = null;

    await this.execute();
  }

  async execute(): Promise<void> {
    while (this.queue.length > 0) {
      const queue = this.queue.map(fn => {
        try {
          return fn()
        } catch (e) {
          // Ignore errors, for now.
          return Promise.resolve();
        }
      });

      this.queue = [];

      await Promise.all(queue);
      if (this.emptyResolve !== null) {
        this.emptyResolve();
        this.emptyResolve = null;
      }
      this.empty = Promise.resolve();
    }
  }

  schedule(task: IdleTask): void {
    this.queue.push(task);
    if (this.emptyResolve === null) {
      this.empty = new Promise(resolve => {
        this.emptyResolve = resolve;
      });
    }
  }

  get size(): number {
    return this.queue.length;
  }
}