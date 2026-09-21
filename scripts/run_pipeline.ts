/**
 * run_pipeline.ts — News auto-production pipeline orchestrator (TypeScript).
 *
 * Runs the three stages in sequence with strict error handling. The WHOLE
 * pipeline fails (process exits non-zero, aborting the cron run) if any stage
 * fails. Each stage's output is validated before the next stage runs.
 *
 * Stages:
 *   1. scripts/khu_crawler.ts   → _workspace/01_notice.md, 01_notice_images/, 02_ocr_results.md
 *   2. scripts/scenarist.ts    → _workspace/03_news_scenario.md
 *   3. scripts/news_builder.ts → _workspace/04_news_files/{week}_full_news.wav
 *
 * Run (from repo root):
 *   npx tsx scripts/run_pipeline.ts
 *   npx tsx scripts/run_pipeline.ts --week=2026-08-10   # specific week
 *   npx tsx scripts/run_pipeline.ts --no-ocr            # pass --no-ocr to the crawler
 *
 * Exit codes: 0 = success, 1 = any stage failed, 2 = bad args.
 */
import { spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = process.cwd();
const WORK = path.join(ROOT, "_workspace");
const NOTICE_MD = path.join(WORK, "01_notice.md");
const SCRAPE_MD = path.join(WORK, "01_scraping_report.md");
const SCENARIO_MD = path.join(WORK, "03_news_scenario.md");
const OUTPUT_DIR = path.join(WORK, "04_news_files");

interface Args {
  week: string | null;
  ocr: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { week: null, ocr: true };
  for (const a of argv) {
    if (a.startsWith("--week=")) args.week = a.slice("--week=".length);
    else if (a === "--no-ocr") args.ocr = false;
    else if (a === "-h" || a === "--help") {
      console.log("usage: npx tsx scripts/run_pipeline.ts [--week=YYYY-MM-DD] [--no-ocr]");
      process.exit(0);
    } else {
      fail(`unknown arg: ${a}`);
    }
  }
  return args;
}

function fail(msg: string): never {
  console.error(`PIPELINE FAILED: ${msg}`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`\n[${new Date().toISOString()}] ${msg}`);
}

// ----------------------------------------------------------------------------
// .env loader — loads KEY=VAL pairs if GEMINI_API_KEY isn't already set.
// ----------------------------------------------------------------------------
async function loadEnv(): Promise<void> {
  if (process.env.GEMINI_API_KEY) return; // already in environment
  try {
    const raw = await fsp.readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* .env missing — rely on environment vars */
  }
}

// ---------------------------------------------------------------------------
// Stage runner — inherits stdio; aborts the whole pipeline on non-zero exit.
// ---------------------------------------------------------------------------
function runStage(stage: string, cmd: string, args: string[]): void {
  log(stage);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: false });
  if (res.error) fail(`could not run "${cmd}": ${res.error.message}`);
  if (res.status !== 0) {
    fail(`${stage} exited with status ${res.status ?? "unknown"}`);
  }
}

// ---------------------------------------------------------------------------
// Output validation — missing/empty stage output fails the pipeline.
// ---------------------------------------------------------------------------
async function requireFile(desc: string, file: string): Promise<void> {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || st.size === 0) fail(`stage output missing/empty — expected ${desc} at ${file}`);
  log(`PASS: ${desc} -> ${file} (${st!.size} bytes)`);
}

async function newestFullNews(): Promise<string | null> {
  const files = await fsp.readdir(OUTPUT_DIR).catch(() => [] as string[]);
  const candidates = files.filter((f) => f.endsWith("_full_news.wav"));
  if (candidates.length === 0) return null;
  const withTime = await Promise.all(
    candidates.map(async (f) => {
      const st = await fsp.stat(path.join(OUTPUT_DIR, f)).catch(() => null);
      return { f, mtime: st ? st.mtimeMs : 0 };
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].f;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const crawlerArgs = ["scripts/khu_crawler.ts"];
  if (args.week) crawlerArgs.push(`--week=${args.week}`);
  if (!args.ocr) crawlerArgs.push("--no-ocr");

  // Env guard: TTS needs the API key.
  if (!process.env.GEMINI_API_KEY) fail("GEMINI_API_KEY is not set (expected in .env or environment)");

  // STAGE 1 — collector + ocr-director
  runStage("STAGE 1/3: crawling KHU notice board (collector + ocr-director)", "npx", ["tsx", ...crawlerArgs]);
  await requireFile("notice markdown", NOTICE_MD);
  await requireFile("scraping report", SCRAPE_MD);

  // STAGE 2 — scenarist
  runStage("STAGE 2/3: writing radio news scenario (scenarist)", "npx", ["tsx", "scripts/scenarist.ts"]);
  await requireFile("news scenario", SCENARIO_MD);

  // STAGE 3 — news-builder (Gemini multi-speaker TTS)
  runStage("STAGE 3/3: synthesizing full news audio (news-builder)", "npx", ["tsx", "scripts/news_builder.ts"]);

  const full = await newestFullNews();
  if (!full) fail(`news-builder did not produce a *_full_news.wav in ${OUTPUT_DIR}`);
  const p = path.join(OUTPUT_DIR, full);
  const st = await fsp.stat(p).catch(() => null);
  if (!st || st.size === 0) fail(`news audio ${p} is empty`);
  log(`PASS: full news audio -> ${p} (${st!.size} bytes)`);

  console.log("\n" + "=".repeat(60));
  console.log(" PIPELINE COMPLETE");
  console.log(`  week       : ${args.week ?? "<this calendar week>"}`);
  console.log(`  news audio : ${p}`);
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("[run_pipeline] FATAL:", err);
  process.exit(1);
});
