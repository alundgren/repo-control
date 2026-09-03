export type PatchLine = {
  kind: "added" | "removed" | "hunk" | "context";
  text: string;
};

export function parseUnifiedPatch(patch: string): PatchLine[] {
  let inHunk = false;
  return patch.split("\n").map((text) => {
    if (text.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text };
    }
    if (inHunk && text.startsWith("+")) return { kind: "added", text };
    if (inHunk && text.startsWith("-")) return { kind: "removed", text };
    return { kind: "context", text };
  });
}
