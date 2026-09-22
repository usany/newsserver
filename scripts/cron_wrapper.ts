#!/usr/bin/env -S npx tsx
/**
 * scripts/cron_wrapper.ts — node-cron daemon & pipeline executor for the news pipeline.
 *
 * Daemon mode (default):
 *   Runs as a long-lived process that schedules the pipeline with node-cron
 *   (instead of relying on the OS crontab). It:
 *     1. Restores a usable PATH (node/npx/tsx/playwright)
 *     2. cd's to the repo root and loads .env
 *     3. Registers a node-cron job (default: every Friday 22:00, Asia/Seoul)
 *     4. Executes the pipeline from orchestration.json when the job fires
 *        (noOverlap guards against concurrent runs if a run overruns its slot)
 *
 *   This process is meant to be kept alive by a launchd LaunchAgent installed by
 *   scripts/install_cron.ts (see that file). Windows/Linux users can run it
 *   under a process manager (pm2, systemd, nohup, etc.).
 *
 * One-off mode (--now):
 *   Executes the pipeline once immediately from pipeline-orchestration.json,
 *   then exits. This is the primary entry point for manual pipeline runs.
 *
 * Schedule is read from the SCHEDULE env var or --schedule="..." (default Fri 22:00).
 *
 * Run:
 *   npx tsx scripts/cron_wrapper.ts --now                  # run once
 *   npx tsx scripts/cron_wrapper.ts --now --week=2026-08-10
 *   npx tsx scripts/cron_wrapper.ts --now --no-ocr
 *   npx tsx scripts/cron_wrapper.ts                            # daemon, default schedule
 *   npx tsx scripts/cron_wrapper.ts --schedule="0 9 * * 1"
 */
import cron from "node-cron";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();

// --- Restore a usable PATH for cron/minimal environments ---
const extra = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/homebrew/opt/node/bin",
  `${HOME}/.local/bin`,
].join(path.delimiter);
const merged = `${extra}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`;
process.env.PATH = [...new Set(merged.split(path.delimiter).filter(Boolean))].join(path.delimiter);

// --- Resolve repo root and cd there ---
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const TZ = process.env.TZ || "Asia/Seoul";

// --- Parse args ---
function parseArgs(argv: string[]): {
  runNow: boolean;
  schedule: string | null;
  pipelineArgs: string[];
} {
  let runNow = false;
  let schedule: string | null = null;
  const pipelineArgs: string[] = [];

  for (const a of argv) {
    if (a === "--now") runNow = true;
    else if (a.startsWith("--schedule=")) schedule = a.slice("--schedule=".length);
    else if (a.startsWith("--week=") || a === "--no-ocr") {
      pipelineArgs.push(a);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { runNow, schedule, pipelineArgs };
}

// --- Load pipeline orchestration ---
interface PipelineStage {
  id: number;
  name: string;
  script: string;
  args: string[];
  outputs: Array<{ desc: string; path: string }>;
}

interface PipelineConfig {
  name: string;
  stages: PipelineStage[];
  env: { required: string[]; dotenv: string };
  args: Array<{
    name: string;
    flag: string;
    type: string;
    default?: boolean | string;
    stages: number[];
  }>;
}

function loadOrchestration(): PipelineConfig {
  const orchestPath = path.join(ROOT, "pipeline-orchestration.json");
  const raw = fs.readFileSync(orchestPath, "utf8");
  return JSON.parse(raw) as PipelineConfig;
}

// --- Fail helper ---
function fail(msg: string): never {
  console.log(`[${new Date().toISOString()}] PIPELINE FAILED: ${msg}`);
  process.exit(1);
}

// --- Stage runner ---
function runStage(stage: PipelineStage, stageArgs: string[]): void {
  console.log(`[${new Date().toISOString()}] STAGE ${stage.id}/3: ${stage.name}`);
  const script = path.join(ROOT, stage.script);
  const args = [...stage.args, ...stageArgs];
  const res = spawnSync("node", [script, ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (res.error) fail(`could not run stage: ${res.error.message}`);
  if (res.status !== 0) fail(`stage exited with status ${res.status}`);
}

// --- Output validation ---
async function requireFile(desc: string, filePath: string): Promise<void> {
  // Handle glob patterns
  if (filePath.includes("*")) {
    const dir = path.dirname(filePath);
    const pattern = path.basename(filePath);
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const globPattern = pattern.replace(/\*/g, "");
    const matches = files.filter((f) => f.includes(globPattern));
    if (matches.length === 0) fail(`no files matching ${desc} at ${filePath}`);
    const stat = await fsp.stat(path.join(dir, matches[0])).catch(() => null);
    if (!stat || stat.size === 0) fail(`${desc} is empty`);
    console.log(`[${new Date().toISOString()}] PASS: ${desc} (${matches[0]}, ${stat.size} bytes)`);
    return;
  }

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) fail(`${desc} missing or empty at ${filePath}`);
  console.log(`[${new Date().toISOString()}] PASS: ${desc} (${stat.size} bytes)`);
}

// --- Build stage args from orchestration and CLI args ---
function buildStageArgs(
  stageId: number,
  config: PipelineConfig,
  cliArgs: string[]
): string[] {
  const args: string[] = [];
  const relevantArgDefs = config.args.filter((a) => a.stages.includes(stageId));

  for (const def of relevantArgDefs) {
    const cliArg = cliArgs.find(
      (a) =>
        a.startsWith(`${def.flag}=`) ||
        a === def.flag
    );

    if (cliArg) {
      if (def.type === "boolean") {
        args.push(def.flag);
      } else {
        args.push(cliArg);
      }
    }
  }

  return args;
}

// --- Execute pipeline from orchestration ---
async function executePipeline(cliArgs: string[]): Promise<void> {
  const config = loadOrchestration();

  // Check env requirements
  for (const key of config.env.required) {
    if (!process.env[key]) {
      fail(`${key} is not set (expected in .env or environment)`);
    }
  }

  // Check compiled scripts exist
  for (const stage of config.stages) {
    const scriptPath = path.join(ROOT, stage.script);
    try {
      fs.statSync(scriptPath);
    } catch {
      fail(`compiled script not found: ${scriptPath}\n  Run: pnpm run build:scripts`);
    }
  }

  // Execute each stage
  for (const stage of config.stages) {
    const stageArgs = buildStageArgs(stage.id, config, cliArgs);
    runStage(stage, stageArgs);

    // Validate outputs
    for (const output of stage.outputs) {
      const outputPath = path.join(ROOT, output.path);
      await requireFile(output.desc, outputPath);
    }
  }

  console.log(`[${new Date().toISOString()}] PIPELINE COMPLETE`);
}

// --- Run the pipeline in this process (--now mode) ---
async function runPipelineOnce(cliArgs: string[]): Promise<void> {
  console.log(`[${new Date().toISOString()}] RUN triggered (--now)`);
  try {
    await executePipeline(cliArgs);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// --- Run pipeline in daemon mode (on cron schedule or --run-now) ---
function runPipelineDaemon(trigger: string): void {
  console.log(`[${new Date().toISOString()}] RUN triggered (${trigger})`);
  executePipeline([]).catch((err) => {
    console.log(`[${new Date().toISOString()}] pipeline error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// --- Main ---
async function main(): Promise<void> {
  const { runNow, schedule, pipelineArgs } = parseArgs(
    process.argv.slice(2)
  );

  if (runNow) {
    // One-off mode: run pipeline once and exit
    await runPipelineOnce(pipelineArgs);
    process.exit(0);
  }

  // Daemon mode
  const SCHEDULE = schedule || process.env.SCHEDULE || "0 22 * * 5"; // default: Friday 22:00

  if (!cron.validate(SCHEDULE)) {
    console.log(`[${new Date().toISOString()}] FATAL: invalid cron expression: "${SCHEDULE}"`);
    process.exit(1);
  }

  const task = cron.schedule(
    SCHEDULE,
    () => runPipelineDaemon(`scheduled ${SCHEDULE}`),
    { name: "radio-news", timezone: TZ, noOverlap: true },
  );

  console.log(`[${new Date().toISOString()}] node-cron daemon started`);
  console.log(`[${new Date().toISOString()}]   schedule : ${SCHEDULE} (${TZ})`);
  console.log(`[${new Date().toISOString()}]   next run : ${task.getNextRun() ? task.getNextRun()!.toISOString() : "n/a"}`);
  console.log(`[${new Date().toISOString()}]   root     : ${ROOT}`);

  // Keep the process alive (node-cron tasks keep the event loop ref'd by default).
  process.on("SIGTERM", () => {
    console.log(`[${new Date().toISOString()}] received SIGTERM, shutting down`);
    task.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.log(`[${new Date().toISOString()}] received SIGINT, shutting down`);
    task.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.log(`[${new Date().toISOString()}] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});