import type { Cache } from "../cache/index.js";
import type { GitHubReadClient } from "../github/read-client.js";
import { parseUnifiedPatch } from "../github/unified-patch.js";
import { ExplorationError, type Selection, type Source } from "./contracts.js";
import type { Evidence, ExplorationRepository } from "./engine.js";

const excluded = /(^|\/)(node_modules|vendor|dist|build|\.git|\.env(?:\.[^/]*)?|[^/]*\.(?:lock|pem|key|p12|pfx))($|\/)/i;
function safePath(path: string) { return path.length <= 1024 && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === "." || !part) && !Array.from(path).some(character => character.charCodeAt(0) < 32 || character === "\\") && !excluded.test(path); }
function excerpt(path: string, side: "LEFT" | "RIGHT", code: string, startLine: number, endLine: number): Omit<Source, "id"> | null {
  const lines = code.split("\n");
  if (startLine > lines.length) return null;
  const end = Math.min(endLine, lines.length);
  const selected = lines.slice(startLine - 1, end).join("\n");
  if (Buffer.byteLength(selected) > 8 * 1024) return null;
  return { path, side, startLine, endLine: end, code: selected };
}
export function createExplorationRepository(cache: Cache, client: Pick<GitHubReadClient, "readPullRequestDiff">, token: string, fetcher: typeof fetch = fetch): ExplorationRepository {
  function target(nodeId: string) {
    const item = cache.getItem(nodeId);
    if (!item || item.type !== "pull_request" || cache.isRepositoryIgnored(item.repositoryId)) throw new ExplorationError("unavailable");
    const repository = cache.getActiveSnapshot()?.repositories.find(entry => entry.id === item.repositoryId);
    if (!repository) throw new ExplorationError("unavailable");
    return { repositoryNameWithOwner: repository.nameWithOwner, number: item.number, title: item.title, base: `https://api.github.com/repos/${repository.nameWithOwner.split("/").map(encodeURIComponent).join("/")}` };
  }
  async function json(url: string, signal: AbortSignal, maximum = 128 * 1024) {
    const response = await fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } });
    if (!response.ok || !response.body) throw new ExplorationError("unavailable");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maximum) throw new ExplorationError("limit"); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel(); }
  }
  async function revision(nodeId: string, headSha: string, signal: AbortSignal, baseSha?: string) {
    const item = target(nodeId);
    const pr = await json(`${item.base}/pulls/${item.number}`, signal);
    target(nodeId);
    if (pr.head?.sha !== headSha || (baseSha && pr.base?.sha !== baseSha)) throw new ExplorationError("head_changed");
    if (typeof pr.base?.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(pr.base.sha)) throw new ExplorationError("unavailable");
    return { ...item, baseSha: pr.base.sha as string, description: typeof pr.body === "string" ? pr.body.slice(0, 8000) : "" };
  }
  type BlobEntry = { path: string; type: string; mode: string; sha: string; size?: number };
  async function source(base: string, commit: string, path: string, signal: AbortSignal, knownEntry?: BlobEntry): Promise<string | null> {
    if (!safePath(path) || path.split("/").length > 20) return null;
    let entry = knownEntry;
    if (!entry) {
      let treeId = commit;
      const parts = path.split("/");
      for (let index = 0; index < parts.length; index++) {
        const tree = await json(`${base}/git/trees/${encodeURIComponent(treeId)}`, signal, 2 * 1024 * 1024);
        if (!Array.isArray(tree.tree) || tree.truncated) return null;
        const found = tree.tree.find((candidate: BlobEntry) => candidate.path === parts[index]) as BlobEntry | undefined;
        if (!found || typeof found.sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(found.sha)) return null;
        if (index === parts.length - 1) entry = found;
        else { if (found.type !== "tree") return null; treeId = found.sha; }
      }
    }
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || typeof entry.size !== "number" || entry.size > 48 * 1024 || !/^[a-f0-9]{40,64}$/i.test(entry.sha)) return null;
    const payload = await json(`${base}/git/blobs/${entry.sha}`, signal);
    if (payload.encoding !== "base64" || typeof payload.content !== "string" || typeof payload.size !== "number" || payload.size > 48 * 1024 || payload.content.length > 70 * 1024) return null;
    const bytes = Buffer.from(payload.content, "base64");
    if (bytes.length > 48 * 1024 || bytes.includes(0)) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  }
  return {
    async verify(nodeId, headSha, signal, baseSha) { await revision(nodeId, headSha, signal, baseSha); },
    async prepare(nodeId, headSha, signal) {
      const item = await revision(nodeId, headSha, signal);
      const diff = await client.readPullRequestDiff({ ...item, signal });
      signal.throwIfAborted();
      if (diff.status === "unavailable") throw new ExplorationError("unavailable");
      if (diff.headSha !== headSha) throw new ExplorationError("head_changed");
      const sources: Omit<Source, "id">[] = [];
      const notices = ["Initial evidence contains selected patch excerpts. Read more source before drawing conclusions about the whole PR."];
      for (const file of diff.files.slice(0, 100)) {
        if (!safePath(file.path) || file.patch.status === "unavailable") continue;
        for (const side of ["RIGHT", "LEFT"] as const) {
          const lines = parseUnifiedPatch(file.patch.text).filter(line => line.side === side && line.line !== null);
          if (!lines.length) continue;
          const start = lines[0]!.line!;
          const contiguous = [];
          for (const line of lines) { if (line.line !== start + contiguous.length || contiguous.length >= 80) break; contiguous.push(line.text.slice(1)); }
          const code = contiguous.join("\n");
          if (Buffer.byteLength(code) <= 8 * 1024) sources.push({ path: file.path, side, startLine: start, endLine: start + contiguous.length - 1, code });
          if (sources.length >= 12) break;
        }
        if (sources.length >= 12) break;
      }
      if (diff.status === "partial" || diff.files.length > 100) notices.push("The changed-file manifest is limited to the first 100 paths.");
      if (diff.files.some(file => file.patch.status !== "available")) notices.push("Some patches are missing or incomplete.");
      await revision(nodeId, headSha, signal, item.baseSha);
      const files: string[] = [];
      let pathBytes = 0;
      for (const file of diff.files) {
        if (!safePath(file.path)) continue;
        pathBytes += Buffer.byteLength(file.path);
        if (files.length >= 100 || pathBytes > 12 * 1024) { notices.push("The changed-path manifest reached its byte or path limit."); break; }
        files.push(file.path);
      }
      return { headSha, baseSha: item.baseSha, description: item.description, title: item.title.slice(0, 1000), files, sources, notices };
    },
    async read(nodeId, headSha, selection: Selection, signal, baseSha): Promise<Evidence> {
      const item = await revision(nodeId, headSha, signal, baseSha);
      if (!safePath(selection.path)) return { sources: [], notices: ["The requested path is excluded from agent evidence."] };
      let commit = headSha;
      let path = selection.path;
      if (selection.side === "LEFT") {
        const comparison = await json(`${item.base}/compare/${item.baseSha}...${headSha}?per_page=1`, signal, 2 * 1024 * 1024);
        commit = comparison.merge_base_commit?.sha;
        if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/i.test(commit)) throw new ExplorationError("unavailable");
        const diff = await client.readPullRequestDiff({ ...item, signal });
        signal.throwIfAborted();
        if (diff.status === "unavailable") throw new ExplorationError("unavailable");
        if (diff.headSha !== headSha) throw new ExplorationError("head_changed");
        path = diff.files.find(file => file.path === path)?.previousPath ?? path;
      }
      let code: string | null;
      try { code = await source(item.base, commit, path, signal); }
      catch (error) { if (signal.aborted) throw error; code = null; }
      const result = code === null ? null : excerpt(selection.path, selection.side, code, selection.startLine, selection.endLine);
      target(nodeId);
      return result ? { sources: [result], notices: [] } : { sources: [], notices: ["Requested source is unavailable, excluded, binary, too large, or outside the file. No code was inferred."] };
    },
    async search(nodeId, headSha, query, pathPrefix, offset, signal, baseSha): Promise<Evidence> {
      const item = await revision(nodeId, headSha, signal, baseSha);
      if (pathPrefix !== null && !safePath(pathPrefix.replace(/\/$/, ""))) throw new ExplorationError("invalid_response");
      const tree = await json(`${item.base}/git/trees/${encodeURIComponent(headSha)}?recursive=1`, signal, 2 * 1024 * 1024);
      if (!Array.isArray(tree.tree)) throw new ExplorationError("unavailable");
      const eligible = tree.tree.filter((entry: { type?: unknown; path?: unknown; size?: unknown; mode?: unknown }) => entry.type === "blob" && ["100644", "100755"].includes(String(entry.mode)) && typeof entry.path === "string" && safePath(entry.path) && (pathPrefix === null || entry.path.startsWith(pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`)) && typeof entry.size === "number" && entry.size <= 48 * 1024) as BlobEntry[];
      const candidates = eligible.slice(offset, offset + 40);
      const sources: Omit<Source, "id">[] = []; let read = 0; let consumed = 0;
      const notices: string[] = [];
      for (const file of candidates) {
        signal.throwIfAborted();
        consumed++;
        let code: string | null;
        try { code = await source(item.base, headSha, file.path, signal, file); } catch (error) { if (signal.aborted) throw error; continue; }
        if (code === null) continue;
        read++;
        const lines = code.split("\n");
        let lineIndex = 0;
        for (; lineIndex < lines.length && sources.length < 30; lineIndex++) if (lines[lineIndex]!.includes(query)) {
          const found = excerpt(file.path, "RIGHT", code, Math.max(1, lineIndex - 2), Math.min(lines.length, lineIndex + 4));
          if (found) sources.push(found);
        }
        if (sources.length >= 30) {
          if (lineIndex < lines.length) notices.push(`The match limit stopped inside ${file.path} after line ${lineIndex}. Remaining lines were not searched; request a file range to inspect them.`);
          break;
        }
      }
      target(nodeId);
      const nextOffset = offset + consumed;
      return { sources, notices: [...notices, `Text search inspected ${read} files at the reviewed head, in ${pathPrefix ?? "the repository"}, starting at offset ${offset}, with a 40-file and 30-match limit. Excluded, oversized and unreadable files were skipped. Results are partial text matches, not verified symbol usages.${nextOffset < eligible.length ? nextOffset <= 1960 ? ` More files are available at offset ${nextOffset}; narrow the directory if needed.` : " More files remain beyond the offset limit; narrow the directory to continue." : ""}${tree.truncated ? " GitHub also truncated the tree." : ""}`] };
    },
  };
}
