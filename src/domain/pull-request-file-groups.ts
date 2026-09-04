export type PullRequestFileGroup = {
  name: string;
  fileIndexes: number[];
};

type FileForGrouping = {
  path: string;
};

const categoryOrder = ["Tests", "Documentation", "Configuration", "Assets"] as const;
type Category = typeof categoryOrder[number];

const configurationNames = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "composer.json",
  "gemfile",
  "mix.exs",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "gemfile.lock",
]);

const assetExtensions = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
  ".mov",
];

export function groupPullRequestFiles(files: readonly FileForGrouping[]): PullRequestFileGroup[] {
  const categories = new Map<Category, number[]>();
  const directories = new Map<string, number[]>();
  const useLowercaseGroupNames = files.every((file) => file.path === file.path.toLowerCase());

  files.forEach((file, index) => {
    const parts = file.path.split("/");
    const basename = parts.at(-1) ?? file.path;
    const category = classifyCategory(parts, basename);
    if (category) {
      addIndex(categories, category, index);
      return;
    }

    const parent = parts.length === 1
      ? formatGroupName("Repository root", useLowercaseGroupNames)
      : parts.slice(0, -1).join("/");
    addIndex(directories, parent, index);
  });

  return [
    ...categoryOrder.flatMap((name) => {
      const fileIndexes = categories.get(name);
      return fileIndexes ? [{ name: formatGroupName(name, useLowercaseGroupNames), fileIndexes }] : [];
    }),
    ...[...directories]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([name, fileIndexes]) => ({ name, fileIndexes })),
  ];
}

function formatGroupName(name: string, useLowercaseGroupNames: boolean) {
  return useLowercaseGroupNames ? name.toLowerCase() : name;
}

function classifyCategory(parts: string[], basename: string): Category | null {
  const segments = parts.map((part) => part.toLowerCase());
  const lowerBasename = basename.toLowerCase();

  if (
    segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__") ||
    lowerBasename.includes(".test.") ||
    lowerBasename.includes(".spec.")
  ) return "Tests";

  if (
    segments.some((segment) => segment === "doc" || segment === "docs" || segment === "documentation") ||
    lowerBasename.startsWith("readme") ||
    lowerBasename.startsWith("changelog") ||
    lowerBasename.startsWith("license")
  ) return "Documentation";

  if (
    segments.includes(".github") ||
    (parts.length === 1 && lowerBasename.startsWith(".")) ||
    lowerBasename.includes(".config.") ||
    configurationNames.has(lowerBasename)
  ) return "Configuration";

  if (
    segments.some((segment) => segment === "assets" || segment === "static" || segment === "public") ||
    assetExtensions.some((extension) => lowerBasename.endsWith(extension))
  ) return "Assets";

  return null;
}

function addIndex<Key>(groups: Map<Key, number[]>, key: Key, index: number) {
  const existing = groups.get(key);
  if (existing) existing.push(index);
  else groups.set(key, [index]);
}

function compareStrings(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
