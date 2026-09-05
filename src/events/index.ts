import type { RefreshChange } from "../refresh/index.js";

export type SettingsChange = {
  status: "settings";
  revision: number;
  visibleItemCount: number;
  visibleRepositoryCount: number;
  ignoredRepositoryCount: number;
};

export type ChangeEvent = RefreshChange | SettingsChange;
export type ChangeSubscriber = (change: ChangeEvent) => void;

export type ChangeEventHub = {
  publish(change: ChangeEvent): void;
  subscribe(subscriber: ChangeSubscriber): () => void;
  subscriberCount(): number;
};

export function createChangeEventHub(): ChangeEventHub {
  const subscribers = new Set<ChangeSubscriber>();
  return {
    publish(change) {
      for (const subscriber of subscribers) {
        try {
          subscriber(change);
        } catch {
          // A broken browser connection must not affect cache or refresh work.
        }
      }
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}
