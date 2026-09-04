export const maxDraftComments = 100;
export const maxDraftBodyBytes = 16 * 1024;
export const maxSavedDraftBytes = 1024 * 1024;

export type DraftSide = "LEFT" | "RIGHT";

export type DraftComment = {
  id: string;
  path: string;
  line: number;
  side: DraftSide;
  body: string;
};

export type DraftCollection = {
  pullRequestId: string;
  headSha: string;
  drafts: DraftComment[];
};

export type SaveDraftResult =
  | { status: "saved" }
  | { status: "rejected"; reason: "body_limit" | "comment_limit" | "tab_limit" };

const storagePrefix = "repo-control:pull-request-drafts:";
const encoder = new TextEncoder();

export class DraftCommentStore {
  readonly collections = new Map<string, DraftCollection>();
  recoveryAvailable: boolean;
  private storage: Storage | null;

  constructor(storage: Storage | null) {
    this.storage = storage;
    this.recoveryAvailable = storage !== null;
    if (storage) this.readStorage(storage);
  }

  collectionsFor(pullRequestId: string): DraftCollection[] {
    return [...this.collections.values()]
      .filter((collection) => collection.pullRequestId === pullRequestId && collection.drafts.length > 0)
      .sort((left, right) => left.headSha.localeCompare(right.headSha));
  }

  save(pullRequestId: string, headSha: string, draft: DraftComment): SaveDraftResult {
    if (encoder.encode(draft.body).byteLength > maxDraftBodyBytes) {
      return { status: "rejected", reason: "body_limit" };
    }

    const key = collectionKey(pullRequestId, headSha);
    const current = this.collections.get(key) ?? { pullRequestId, headSha, drafts: [] };
    const existingIndex = current.drafts.findIndex((candidate) => candidate.id === draft.id);
    if (existingIndex < 0 && current.drafts.length >= maxDraftComments) {
      return { status: "rejected", reason: "comment_limit" };
    }

    const drafts = [...current.drafts];
    if (existingIndex < 0) drafts.push(draft); else drafts[existingIndex] = draft;
    const next = { ...current, drafts };
    const previous = this.collections.get(key);
    this.collections.set(key, next);
    if (this.serializedBytes() > maxSavedDraftBytes) {
      if (previous) this.collections.set(key, previous); else this.collections.delete(key);
      return { status: "rejected", reason: "tab_limit" };
    }
    this.writeCollection(key, next);
    return { status: "saved" };
  }

  delete(pullRequestId: string, headSha: string, draftId: string): void {
    const key = collectionKey(pullRequestId, headSha);
    const current = this.collections.get(key);
    if (!current) return;
    const next = { ...current, drafts: current.drafts.filter((draft) => draft.id !== draftId) };
    if (next.drafts.length === 0) {
      this.collections.delete(key);
      this.removeCollection(key);
    } else {
      this.collections.set(key, next);
      this.writeCollection(key, next);
    }
  }

  discardPullRequest(pullRequestId: string): void {
    for (const [key, collection] of this.collections) {
      if (collection.pullRequestId !== pullRequestId) continue;
      this.collections.delete(key);
      this.removeCollection(key);
    }
  }

  discardCollection(pullRequestId: string, headSha: string): { persistenceCleared: boolean } {
    const key = collectionKey(pullRequestId, headSha);
    this.collections.delete(key);
    return { persistenceCleared: this.removeCollection(key) };
  }

  private serializedBytes(): number {
    return [...this.collections.values()].reduce(
      (total, collection) => total + encoder.encode(JSON.stringify(collection)).byteLength,
      0,
    );
  }

  private readStorage(storage: Storage): void {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(storagePrefix)) continue;
        const value = storage.getItem(key);
        if (!value) continue;
        const collection = parseCollection(value);
        if (collection) this.collections.set(key, collection);
      }
    } catch {
      this.storage = null;
      this.recoveryAvailable = false;
      this.collections.clear();
    }
  }

  private writeCollection(key: string, collection: DraftCollection): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, JSON.stringify(collection));
    } catch {
      this.recoveryAvailable = false;
    }
  }

  private removeCollection(key: string): boolean {
    if (!this.storage) return false;
    try {
      this.storage.removeItem(key);
      return true;
    } catch {
      this.storage = null;
      this.recoveryAvailable = false;
      return false;
    }
  }
}

export function getSessionStorage(): Storage | null {
  try {
    const storage = window.sessionStorage;
    void storage.length;
    return storage;
  } catch {
    return null;
  }
}

function collectionKey(pullRequestId: string, headSha: string): string {
  return `${storagePrefix}${encodeURIComponent(pullRequestId)}:${encodeURIComponent(headSha)}`;
}

function parseCollection(value: string): DraftCollection | null {
  try {
    const parsed = JSON.parse(value) as Partial<DraftCollection>;
    if (typeof parsed.pullRequestId !== "string" || typeof parsed.headSha !== "string" || !Array.isArray(parsed.drafts)) return null;
    const drafts = parsed.drafts.filter(isDraftComment);
    return drafts.length === parsed.drafts.length ? { pullRequestId: parsed.pullRequestId, headSha: parsed.headSha, drafts } : null;
  } catch {
    return null;
  }
}

function isDraftComment(value: unknown): value is DraftComment {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<DraftComment>;
  return typeof draft.id === "string"
    && typeof draft.path === "string"
    && Number.isSafeInteger(draft.line)
    && (draft.side === "LEFT" || draft.side === "RIGHT")
    && typeof draft.body === "string";
}
