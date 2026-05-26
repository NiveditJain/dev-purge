#!/usr/bin/env node

import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import ora from "ora";
import { scan } from "./scanner.js";
import {
  printResults,
  printCleanSummary,
  printWatchHeader,
  formatSize,
  colorSize,
  printProjectPrompt,
} from "./display.js";
import { clean } from "./cleaner.js";
import { ask } from "./prompt.js";
import { manageDocker, removeContainers, removeImages } from "./docker.js";

// ── Parse args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);

function hasFlag(...names) {
  return names.some((n) => args.includes(n));
}

// Boolean (no-value) flags and value-taking flags. Combined into KNOWN_FLAGS so
// that value parsing can tell "the next token is this flag's value" apart from
// "the next token is a different flag". A token that merely starts with "-" but
// isn't a flag we recognize (e.g. a path literally named "-tmp", or the glob
// "-cache/**") is treated as a value — this keeps getFlagValue and
// getFlagValues consistent and stops them silently dropping such values.
const BOOLEAN_FLAGS = [
  "--dry-run",
  "--all",
  "-a",
  "--watch",
  "--help",
  "-h",
  "--json",
  "--ide",
  "--containers-only",
  "--images-only",
];
const flagsWithValues = new Set([
  "--older-than",
  "-d",
  "--depth",
  "-s",
  "--min-size",
  "--category",
  "--ignore",
]);
const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, ...flagsWithValues]);

function isKnownFlag(token) {
  return KNOWN_FLAGS.has(token);
}

// True when `token` exists and isn't itself a recognized flag, i.e. it can be
// consumed as the value of the preceding flag.
function isValueToken(token) {
  return token !== undefined && !isKnownFlag(token);
}

function getFlagValue(name) {
  // --foo=bar
  for (const arg of args) {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  // --foo bar
  const idx = args.indexOf(name);
  if (idx !== -1 && isValueToken(args[idx + 1])) {
    return args[idx + 1];
  }
  return null;
}

function getFlagValues(name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      if (isValueToken(args[i + 1])) {
        values.push(args[i + 1]);
        i++;
      }
    } else if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
    }
  }
  return values;
}

// Positional args (not flags and not flag values)
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("-")) {
    if (flagsWithValues.has(args[i]) && isValueToken(args[i + 1])) i++; // skip value
    continue;
  }
  // skip if previous arg was a flag expecting a value
  if (i > 0 && flagsWithValues.has(args[i - 1])) continue;
  positional.push(args[i]);
}

const dryRun = hasFlag("--dry-run");
const cleanAll = hasFlag("--all", "-a");
const watch = hasFlag("--watch");
const help = hasFlag("--help", "-h");
const json = hasFlag("--json");
const includeIde = hasFlag("--ide");
const containersOnly = hasFlag("--containers-only");
const imagesOnly = hasFlag("--images-only");

// "containers only" and "images only" are mutually exclusive — combining two
// "only" flags is contradictory. Fail loudly rather than silently picking one,
// so cron-driven invocations get a clear error instead of surprising behavior.
if (containersOnly && imagesOnly) {
  console.error(
    chalk.red(
      "  --containers-only and --images-only are mutually exclusive; pass at most one.",
    ),
  );
  process.exit(1);
}

const olderThanRaw = getFlagValue("--older-than");
const olderThanMs = olderThanRaw ? parseDuration(olderThanRaw) : null;

const depthRaw = getFlagValue("-d") || getFlagValue("--depth");
const maxDepth = depthRaw ? parseInt(depthRaw, 10) : 6;

const minSizeRaw = getFlagValue("-s") || getFlagValue("--min-size");
const minSize = minSizeRaw !== null ? parseSize(minSizeRaw) : 1024 * 1024; // default 1 MB

const categoryRaw = getFlagValue("--category");
const categories = categoryRaw ? new Set(categoryRaw.split(",")) : null;

// Split categories into filesystem vs. runtime (Docker) scopes. The scanner
// only understands filesystem categories, so it gets `fsCategories`.
const FILESYSTEM_CATEGORIES = new Set(["deps", "build", "cache", "test"]);
const fsCategories = categories
  ? new Set([...categories].filter((c) => FILESYSTEM_CATEGORIES.has(c)))
  : null;
const runtimeOnly = containersOnly || imagesOnly;
// Skip the (potentially slow) filesystem walk when the user asked only for
// runtime cleanup, or filtered to categories that are all runtime.
const shouldScanFilesystem =
  !runtimeOnly && (!categories || fsCategories.size > 0);

const categoryIncludesContainers = categories
  ? categories.has("containers")
  : true;
const categoryIncludesImages = categories ? categories.has("images") : true;
// At most one of containersOnly/imagesOnly is set (guarded above), so this is
// unambiguous.
const includeContainers = containersOnly
  ? true
  : imagesOnly
    ? false
    : categoryIncludesContainers;
const includeImages = imagesOnly
  ? true
  : containersOnly
    ? false
    : categoryIncludesImages;

const rootPath = resolve(positional[0] || ".");

// Resolve ignore patterns from the config file (defaults) merged with CLI
// `--ignore` flags. Deferred to call time rather than top-level: reading the
// config eagerly would run before the `--help` short-circuit, so a slow or hung
// $XDG_CONFIG_HOME mount could hang `dev-purge --help`.
async function loadIgnorePatterns() {
  const configHome =
    process.env.XDG_CONFIG_HOME ||
    resolve(process.env.HOME || homedir(), ".config");
  const cfgPath = resolve(configHome, "dev-purge", "config.json");

  const configIgnore = [];
  try {
    const raw = await readFile(cfgPath, "utf-8");
    const cfg = JSON.parse(raw);
    if (Array.isArray(cfg.ignore)) {
      for (const entry of cfg.ignore) {
        if (typeof entry === "string" && entry.trim()) {
          configIgnore.push(entry);
        } else {
          // Predictability matters for cron-driven runs: surface bad entries
          // instead of silently dropping them.
          console.warn(
            chalk.yellow(
              `  Ignoring invalid "ignore" entry in ${cfgPath}: ${JSON.stringify(entry)}`,
            ),
          );
        }
      }
    }
  } catch {
    // no config or unreadable — fall back to CLI-only ignore patterns
  }

  // CLI-provided patterns (repeatable), appended after config defaults.
  const cliIgnore = getFlagValues("--ignore");
  return [...new Set([...configIgnore, ...cliIgnore])];
}

// ── Main ────────────────────────────────────────────────────────────
if (help) {
  printHelp();
  process.exit(0);
}

if (watch) {
  await runWatch();
} else {
  await run();
}

async function run() {
  // Resolve ignore patterns before the spinner starts so any config warnings
  // print cleanly instead of being overwritten by the spinner.
  const ignorePatterns = await loadIgnorePatterns();

  const spinner =
    json || !shouldScanFilesystem
      ? {
          start() {
            return this;
          },
          stop() {},
          set text(_) {},
        }
      : ora({
          text: chalk.dim("Scanning for bloat directories..."),
          color: "cyan",
        }).start();

  let lastUpdate = 0;
  const results = shouldScanFilesystem
    ? await scan(rootPath, {
        olderThanMs,
        maxDepth,
        categories: fsCategories,
        minSize,
        includeIde,
        ignorePatterns,
        onProgress(dir) {
          const now = Date.now();
          if (now - lastUpdate > 100) {
            lastUpdate = now;
            const short = dir.length > 60 ? "..." + dir.slice(-57) : dir;
            spinner.text = chalk.dim(`Scanning: ${short}`);
          }
        },
      })
    : [];

  spinner.stop();

  if (json) {
    printJson(results);
    return;
  }

  if (shouldScanFilesystem) {
    printResults(results, rootPath);
  }

  const runtime = await scanRuntimeTargets();
  printRuntimeSummary(runtime);

  const hasFsCandidates = results.length > 0;
  const hasRuntimeCandidates =
    runtime.candidatesContainers.length > 0 ||
    runtime.candidatesImages.length > 0;

  // Replaces the old `results.length === 0` early return: now that runtime
  // artifacts can also be actionable, only bail when there is nothing to do in
  // *either* scope. Both summaries have already printed above.
  if (!hasFsCandidates && !hasRuntimeCandidates) return;

  if (dryRun) {
    console.log(chalk.yellow("  --dry-run: no resources were deleted.\n"));
    return;
  }

  if (cleanAll) {
    await cleanAllWithConfirm(results, runtime);
  } else {
    await cycleProjects(results);
    await cleanRuntimeWithConfirm(runtime);
  }
}

async function cleanAllWithConfirm(results, runtime) {
  const allDirs = results.flatMap((p) =>
    p.bloatDirs.map((b) => ({ path: b.path, size: b.size })),
  );
  const totalSize = allDirs.reduce((a, b) => a + b.size, 0);

  if (allDirs.length > 0) {
    const answer = await ask(
      chalk.white(
        `  Delete ${chalk.bold(allDirs.length + " directories")} across ${chalk.bold(results.length + " projects")} (${colorSize(totalSize)})?`,
      ),
    );

    if (!answer) {
      console.log(chalk.dim("\n  Cancelled directory cleanup.\n"));
    } else {
      await deleteItems(allDirs);
    }
  }

  // Docker artifacts are confirmed separately so a "no" on files doesn't also
  // skip runtime cleanup (and vice versa).
  await cleanRuntimeWithConfirm(runtime);
}

async function cycleProjects(results) {
  const toDelete = [];

  for (let i = 0; i < results.length; i++) {
    const project = results[i];
    printProjectPrompt(project, rootPath, i + 1, results.length);
    const answer = await ask(chalk.white("  Clean?"));

    if (answer) {
      toDelete.push(
        ...project.bloatDirs.map((b) => ({ path: b.path, size: b.size })),
      );
    }

    console.log();
  }

  if (toDelete.length === 0) {
    console.log(chalk.dim("  Nothing selected.\n"));
    return;
  }

  await deleteItems(toDelete);
}

async function deleteItems(items) {
  const spinner = ora({ text: chalk.dim("Cleaning..."), color: "red" }).start();

  const { cleaned, failed } = await clean(items, {
    onProgress(item, i, total) {
      spinner.text = chalk.dim(`Deleting (${i + 1}/${total}): ${item.path}`);
    },
  });

  spinner.stop();
  printCleanSummary(cleaned, failed);
}

async function runWatch() {
  printWatchHeader();

  const ignorePatterns = await loadIgnorePatterns();

  const update = async () => {
    const results = shouldScanFilesystem
      ? await scan(rootPath, {
          olderThanMs,
          maxDepth,
          categories: fsCategories,
          minSize,
          includeIde,
          ignorePatterns,
        })
      : [];
    process.stdout.write("\x1B[2J\x1B[H");
    printWatchHeader();
    printResults(results, rootPath);
    console.log(
      chalk.dim(`  Last updated: ${new Date().toLocaleTimeString()}`),
    );
  };

  await update();
  setInterval(update, 5000);
}

function printJson(results) {
  const output = {
    root: rootPath,
    scannedAt: new Date().toISOString(),
    projects: results.map((r) => ({
      path: r.projectPath,
      framework: r.framework,
      lastModified: r.lastModified.toISOString(),
      totalBytes: r.totalSize,
      totalHuman: formatSize(r.totalSize),
      bloat: r.bloatDirs.map((b) => ({
        name: b.name,
        path: b.path,
        category: b.category,
        bytes: b.size,
        human: formatSize(b.size),
      })),
    })),
    summary: {
      projects: results.length,
      directories: results.reduce((a, b) => a + b.bloatDirs.length, 0),
      totalBytes: results.reduce((a, b) => a + b.totalSize, 0),
      totalHuman: formatSize(results.reduce((a, b) => a + b.totalSize, 0)),
    },
  };
  console.log(JSON.stringify(output, null, 2));
}

async function scanRuntimeTargets() {
  if (!includeContainers && !includeImages) {
    return {
      enabled: false,
      unavailableReason: null,
      report: { containers: [], images: [] },
      candidatesContainers: [],
      candidatesImages: [],
    };
  }
  try {
    const report = await manageDocker({
      olderThanMs,
      includeContainers,
      includeImages,
    });

    // When an age filter is active, an artifact whose creation date Docker
    // couldn't provide/parse is kept (the conservative choice). Warn so a user
    // understands why something they expected --older-than to remove survived.
    if (olderThanMs) {
      const blindKept = [
        ...report.containers
          .filter((c) => c.keep && c.created === null)
          .map(
            (c) => `container ${c.id ?? "?"}${c.name ? ` (${c.name})` : ""}`,
          ),
        ...report.images
          .filter((i) => i.keep && i.created === null)
          .map((i) => `image ${i.id ?? "?"}`),
      ];
      for (const label of blindKept) {
        console.warn(
          chalk.yellow(
            `  Kept ${label}: no parseable creation date, so --older-than could not be applied.`,
          ),
        );
      }
    }

    return {
      enabled: true,
      unavailableReason: null,
      report,
      candidatesContainers: report.containers.filter((c) => !c.keep),
      candidatesImages: report.images.filter((i) => !i.keep),
    };
  } catch (err) {
    return {
      enabled: true,
      unavailableReason: err.message || String(err),
      report: { containers: [], images: [] },
      candidatesContainers: [],
      candidatesImages: [],
    };
  }
}

function printRuntimeSummary(runtime) {
  if (!runtime.enabled) return;

  console.log(chalk.cyan.bold("\nRuntime cleanup summary:"));
  if (runtime.unavailableReason) {
    // Mirror the README promise ("skip runtime cleanup and continue") and show
    // the real Docker error dimmed so failures are debuggable rather than a
    // vague "unavailable in this environment".
    console.log(chalk.yellow("  Docker unavailable — skipping runtime cleanup."));
    console.log(chalk.dim(`  (${runtime.unavailableReason})`));
    return;
  }
  if (includeContainers) {
    console.log(
      chalk.white(
        `  Exited containers found: ${runtime.report.containers.length}`,
      ),
    );
    console.log(
      chalk.white(
        `  Candidates to remove: ${runtime.candidatesContainers.length}`,
      ),
    );
  }
  if (includeImages) {
    console.log(
      chalk.white(`  Dangling images found: ${runtime.report.images.length}`),
    );
    console.log(
      chalk.white(`  Candidates to remove: ${runtime.candidatesImages.length}`),
    );
  }
}

async function cleanRuntimeWithConfirm(runtime) {
  if (!runtime.enabled || runtime.unavailableReason) return;
  if (
    runtime.candidatesContainers.length === 0 &&
    runtime.candidatesImages.length === 0
  )
    return;

  const answer = await ask(chalk.white("  Clean container/image artifacts?"));
  if (!answer) {
    console.log(chalk.dim("\n  Cancelled container/image cleanup.\n"));
    return;
  }

  if (runtime.candidatesContainers.length > 0) {
    const ids = runtime.candidatesContainers.map((c) => c.id);
    const res = await removeContainers(ids);
    console.log(chalk.green(`  Removed containers: ${res.cleaned.length}`));
    if (res.failed.length) {
      console.log(
        chalk.red(`  Failed to remove containers: ${res.failed.length}`),
      );
    }
  }

  if (runtime.candidatesImages.length > 0) {
    const ids = runtime.candidatesImages.map((i) => i.id);
    const res = await removeImages(ids);
    console.log(chalk.green(`  Removed images: ${res.cleaned.length}`));
    if (res.failed.length) {
      console.log(chalk.red(`  Failed to remove images: ${res.failed.length}`));
    }
  }
}

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(h|d|w|m|y)$/);
  if (!match) {
    console.error(
      chalk.red(`Invalid duration: "${str}". Use format like 30d, 2w, 6m, 1y`),
    );
    process.exit(1);
  }
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = {
    h: 3600000,
    d: 86400000,
    w: 604800000,
    m: 30 * 86400000,
    y: 365 * 86400000,
  };
  return num * multipliers[unit];
}

function parseSize(str) {
  if (!str) return 0;
  const match = str.match(/^(\d+)(b|k|m|g)?$/i);
  if (!match) {
    console.error(
      chalk.red(`Invalid size: "${str}". Use format like 100m, 1g, 500k`),
    );
    process.exit(1);
  }
  const num = parseInt(match[1], 10);
  const unit = (match[2] || "b").toLowerCase();
  const multipliers = { b: 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  return num * multipliers[unit];
}

function printHelp() {
  console.log(`
${chalk.cyan.bold("dev-purge")} — find and clean dev bloat across your projects

${chalk.white.bold("Usage:")}
  ${chalk.green("dev-purge")}                         Scan + cycle through projects (y/n each)
  ${chalk.green("dev-purge /path/to/projects")}       Scan a specific directory
  ${chalk.green("dev-purge --dry-run")}               Show bloat + runtime artifacts without deleting
  ${chalk.green("dev-purge -a, --all")}               Bulk-delete dirs, then optionally clean Docker leftovers
  ${chalk.green("dev-purge -a --older-than 1y")}      Nuke all bloat older than a year
  ${chalk.green("dev-purge --category deps")}         Only dependencies (node_modules, venv, etc.)
  ${chalk.green("dev-purge --category containers")}   Only exited Docker containers
  ${chalk.green("dev-purge --containers-only")}       Runtime cleanup: exited containers only
  ${chalk.green("dev-purge --images-only")}           Runtime cleanup: dangling images only
  ${chalk.green("dev-purge --json")}                  Machine-readable JSON (filesystem only)
  ${chalk.green("dev-purge --watch")}                 Real-time disk usage monitoring

${chalk.white.bold("Categories:")}
  ${chalk.yellow("deps")}        node_modules, .pnpm-store, .yarn, vendor, bower_components, Pods, venv, .venv
  ${chalk.yellow("build")}       .next, .nuxt, .output, .svelte-kit, .angular, .expo, .vercel, dist, build, out, target, DerivedData
  ${chalk.yellow("cache")}       .cache, .parcel-cache, .turbo, .vite, __pycache__, .pytest_cache, .mypy_cache, .ruff_cache, .gradle, .dart_tool
  ${chalk.yellow("test")}        coverage, .nyc_output, storybook-static
  ${chalk.yellow("containers")}  exited Docker containers
  ${chalk.yellow("images")}      dangling Docker images

${chalk.white.bold("Flags:")}
  --dry-run                Scan and display only, don't delete anything
  -a, --all                Bulk-delete found directories, then optionally clean runtime artifacts
  --older-than <dur>       Filter by age (30d, 2w, 6m, 1y); also applied to Docker artifacts when dated
  --category <cat>         Filter by category: deps, build, cache, test, containers, images (comma-separated)
  -s, --min-size <size>    Minimum bloat size to show (default: 1m, use -s 0 for all)
  -d, --depth <n>          Max scan depth (default: 6)
  --ide                    Also scan IDE caches (.cursor, .vscode, .idea)
  --containers-only        Runtime cleanup of exited containers only (no filesystem scan)
  --images-only            Runtime cleanup of dangling images only (no filesystem scan)
  --json                   Output filesystem results as JSON (runtime artifacts not included)
  --watch                  Continuously monitor and display disk usage
  --ignore <glob>          Ignore paths (absolute, relative to scan root, or bare dir name; repeatable). Also supported in config: ~/.config/dev-purge/config.json {"ignore": ["~/.vscode-server/**"]}
  --help, -h               Show this help
`);
}
