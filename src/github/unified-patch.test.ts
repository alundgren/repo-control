import { describe, expect, it } from "vitest";

import { parseUnifiedPatch } from "./unified-patch.js";

describe("parseUnifiedPatch", () => {
  it("assigns GitHub line and side coordinates across hunks", () => {
    const lines = parseUnifiedPatch("@@ -3,2 +3,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n@@ -20 +21 @@\n-later old\n+later new");

    expect(lines.map(({ kind, line, side }) => ({ kind, line, side }))).toEqual([
      { kind: "hunk", line: null, side: null },
      { kind: "context", line: 3, side: "RIGHT" },
      { kind: "removed", line: 4, side: "LEFT" },
      { kind: "added", line: 4, side: "RIGHT" },
      { kind: "context", line: null, side: null },
      { kind: "hunk", line: null, side: null },
      { kind: "removed", line: 20, side: "LEFT" },
      { kind: "added", line: 21, side: "RIGHT" },
    ]);
  });

  it("does not anchor malformed headers, metadata, or a trailing blank line", () => {
    const lines = parseUnifiedPatch("@@ malformed @@\n+not-a-line\n@@ -1 +1 @@\n-old\n+new\n");

    expect(lines.map(({ line, side }) => ({ line, side }))).toEqual([
      { line: null, side: null },
      { line: null, side: null },
      { line: null, side: null },
      { line: 1, side: "LEFT" },
      { line: 1, side: "RIGHT" },
      { line: null, side: null },
    ]);
  });
});
