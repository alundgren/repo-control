import { describe, expect, it } from "vitest";

import { groupPullRequestFiles } from "./pull-request-file-groups.js";

describe("groupPullRequestFiles", () => {
  it("applies every path and basename category rule case-insensitively", () => {
    const paths = [
      "TEST/helpers.ts",
      "TeStS/helpers.ts",
      "src/__TESTS__/helpers.ts",
      "src/widget.TeSt.tsx",
      "src/widget.SPEC.ts",
      "Doc/guide.txt",
      "Docs/guide.txt",
      "Documentation/guide.txt",
      "src/README-extra.md",
      "CHANGELOG-next",
      "licenses/LICENSE-MIT",
      ".GITHUB/workflows/check.yml",
      ".editorconfig",
      "src/vite.CONFIG.ts",
      "nested/Package.JSON",
      "Assets/archive.bin",
      "Static/archive.bin",
      "Public/archive.bin",
      "src/photo.JPEG",
    ];

    expect(groupPullRequestFiles(paths.map((path) => ({ path })))).toEqual([
      { name: "Tests", fileIndexes: [0, 1, 2, 3, 4] },
      { name: "Documentation", fileIndexes: [5, 6, 7, 8, 9, 10] },
      { name: "Configuration", fileIndexes: [11, 12, 13, 14] },
      { name: "Assets", fileIndexes: [15, 16, 17, 18] },
    ]);
  });

  it("lets the first matching category win", () => {
    const paths = [
      "src/__tests__/README.md",
      "docs/package.json",
      "public/component.test.ts",
      ".github/logo.svg",
    ];

    expect(groupPullRequestFiles(paths.map((path) => ({ path })))).toEqual([
      { name: "Tests", fileIndexes: [0, 2] },
      { name: "Documentation", fileIndexes: [1] },
      { name: "Configuration", fileIndexes: [3] },
    ]);
  });

  it("uses lowercase generated group names when every changed path is lowercase", () => {
    const paths = [
      "tests/widget.test.ts",
      "docs/guide.md",
      "package.json",
      "public/logo.svg",
      "root.ts",
      "src/widget.ts",
    ];

    expect(groupPullRequestFiles(paths.map((path) => ({ path })))).toEqual([
      { name: "tests", fileIndexes: [0] },
      { name: "documentation", fileIndexes: [1] },
      { name: "configuration", fileIndexes: [2] },
      { name: "assets", fileIndexes: [3] },
      { name: "repository root", fileIndexes: [4] },
      { name: "src", fileIndexes: [5] },
    ]);
  });

  it("keeps generated group names capitalized when any changed path contains uppercase letters", () => {
    const paths = [
      "tests/widget.test.ts",
      "README.md",
      "root.ts",
    ];

    expect(groupPullRequestFiles(paths.map((path) => ({ path })))).toEqual([
      { name: "Tests", fileIndexes: [0] },
      { name: "Documentation", fileIndexes: [1] },
      { name: "Repository root", fileIndexes: [2] },
    ]);
  });

  it("covers every exact configuration name and asset extension", () => {
    const configurationNames = [
      "package.json", "pnpm-workspace.yaml", "tsconfig.json", "Cargo.toml", "go.mod",
      "pyproject.toml", "composer.json", "Gemfile", "mix.exs", "pnpm-lock.yaml",
      "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock",
      "poetry.lock", "uv.lock", "go.sum", "Gemfile.lock",
    ];
    const assetExtensions = [
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
      ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".wav", ".ogg",
      ".mp4", ".webm", ".mov",
    ];
    const paths = [
      ...configurationNames.map((name) => `setup/${name}`),
      ...assetExtensions.map((extension, index) => `media/file-${index}${extension}`),
    ];

    expect(groupPullRequestFiles(paths.map((path) => ({ path })))).toEqual([
      { name: "Configuration", fileIndexes: configurationNames.map((_, index) => index) },
      { name: "Assets", fileIndexes: assetExtensions.map((_, index) => index + configurationNames.length) },
    ]);
  });

  it("groups fallback files by their full parent path and orders directories lexically", () => {
    const paths = [
      "src/web/App.tsx",
      "root.ts",
      "src/api/plugin.ts",
      "examples/demo/example.ts",
      "src/web/styles.css",
    ];

    expect(groupPullRequestFiles(paths.map((path) => ({ path })))).toEqual([
      { name: "Repository root", fileIndexes: [1] },
      { name: "examples/demo", fileIndexes: [3] },
      { name: "src/api", fileIndexes: [2] },
      { name: "src/web", fileIndexes: [0, 4] },
    ]);
  });

  it("uses the renamed file's new path and preserves GitHub order within each group", () => {
    const files = [
      { path: "src/first.ts", previousPath: "tests/first.test.ts" },
      { path: "tests/new.test.ts", previousPath: "src/new.ts" },
      { path: "src/second.ts", previousPath: null },
    ];

    expect(groupPullRequestFiles(files)).toEqual([
      { name: "tests", fileIndexes: [1] },
      { name: "src", fileIndexes: [0, 2] },
    ]);
  });

  it("returns no groups for an empty changed-file list", () => {
    expect(groupPullRequestFiles([])).toEqual([]);
  });
});
