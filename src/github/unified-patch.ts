export type PatchLine = {
  kind: "added" | "removed" | "hunk" | "context";
  text: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
};

export function parseUnifiedPatch(patch: string): PatchLine[] {
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  return patch.split("\n").map((text) => {
    if (text.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      inHunk = match !== null;
      oldLine = Number(match?.[1] ?? 0);
      newLine = Number(match?.[2] ?? 0);
      return { kind: "hunk", text, line: null, side: null };
    }
    if (!inHunk || text.startsWith("\\")) return { kind: "context", text, line: null, side: null };
    if (text.startsWith("+")) return { kind: "added", text, line: newLine++, side: "RIGHT" };
    if (text.startsWith("-")) return { kind: "removed", text, line: oldLine++, side: "LEFT" };
    if (!text.startsWith(" ")) return { kind: "context", text, line: null, side: null };
    const line = { kind: "context" as const, text, line: newLine, side: "RIGHT" as const };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}
