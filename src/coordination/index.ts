export type ReconciliationCoordinator = {
  runSync<T>(operation: () => Promise<T>): Promise<T>;
  runItem<T>(operation: () => Promise<T>): Promise<T>;
};

export function createReconciliationCoordinator(): ReconciliationCoordinator {
  let syncRunning = false;
  let syncQueued = false;
  let activeItems = 0;
  let releaseItems: (() => void)[] = [];
  let releaseWaitingItems: (() => void)[] = [];

  async function waitForItems() {
    if (activeItems === 0) return;
    await new Promise<void>((resolve) => releaseItems.push(resolve));
  }

  return {
    async runSync(operation) {
      syncQueued = true;
      await waitForItems();
      syncQueued = false;
      syncRunning = true;
      try {
        return await operation();
      } finally {
        syncRunning = false;
        const waiters = releaseWaitingItems;
        releaseWaitingItems = [];
        waiters.forEach((release) => release());
      }
    },
    async runItem(operation) {
      while (syncRunning || syncQueued) {
        await new Promise<void>((resolve) => releaseWaitingItems.push(resolve));
      }
      activeItems += 1;
      try {
        return await operation();
      } finally {
        activeItems -= 1;
        if (activeItems === 0) {
          const waiters = releaseItems;
          releaseItems = [];
          waiters.forEach((release) => release());
        }
      }
    },
  };
}
