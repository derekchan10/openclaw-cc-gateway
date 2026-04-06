type QueuedTask = {
  tenant: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

export class ConcurrencyQueue {
  private running = 0;
  private perTenant = new Map<string, number>();
  private queue: QueuedTask[] = [];

  constructor(
    private maxConcurrent: number = 3,
    private maxPerTenant: number = 1,
    private maxQueueDepth: number = 20,
  ) {}

  async acquire(tenant: string, run: () => Promise<void>): Promise<void> {
    const currentPerTenant = this.perTenant.get(tenant) || 0;

    // Can run immediately?
    if (this.running < this.maxConcurrent && currentPerTenant < this.maxPerTenant) {
      return this.execute(tenant, run);
    }

    // Queue it
    if (this.queue.length >= this.maxQueueDepth) {
      throw new TooManyRequestsError();
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ tenant, run, resolve, reject });
    });
  }

  private async execute(tenant: string, run: () => Promise<void>): Promise<void> {
    this.running++;
    this.perTenant.set(tenant, (this.perTenant.get(tenant) || 0) + 1);

    try {
      await run();
    } finally {
      this.running--;
      const count = (this.perTenant.get(tenant) || 1) - 1;
      if (count <= 0) this.perTenant.delete(tenant);
      else this.perTenant.set(tenant, count);

      this.drain();
    }
  }

  private drain(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      const currentPerTenant = this.perTenant.get(task.tenant) || 0;

      if (this.running < this.maxConcurrent && currentPerTenant < this.maxPerTenant) {
        this.queue.splice(i, 1);
        this.execute(task.tenant, task.run).then(task.resolve, task.reject);
        return;
      }
    }
  }

  get stats() {
    return {
      running: this.running,
      queued: this.queue.length,
      perTenant: Object.fromEntries(this.perTenant),
    };
  }
}

export class TooManyRequestsError extends Error {
  constructor() {
    super("Too many requests — queue full");
  }
}
