/**
 * scenarist.mts — replaces the `scenarist` agent using the opencode SDK.
 *
 * Mirrors `.claude/agents/scenarist.md`:
 *   1. Reads the notice file `_workspace/01_notice.md`
 *   2. Summarizes the notice contents
 *   3. Writes a two-person (host, reporter) radio news scenario
 *      (do not repeat the same comment from both host and reporter,
 *       include all notices, only readable texts)
 *   4. Writes the result to `_workspace/03_news_scenario.md`
 *
 * Uses `@opencode-ai/sdk`: spins up an in-process opencode server created by
 * `createOpencode()`, creates a session, and asks the model (default: opencode's
 * default model) to play the scenarist role.
 *
 * WHY `.mts` (ESM)? The SDK's package.json `exports` map only defines the
 * `import` condition (no `require`/`default`), so the module must be loaded as
 * ESM. In this project (no `"type": "module"`), `.ts` files are treated as CJS
 * and would fail to resolve `@opencode-ai/sdk`. `.mts` forces ESM.
 *
 * Run (from repo root):
 *   npx tsx scripts/scenarist.mts
 *   npx tsx scripts/scenarist.mts --input=_workspace/01_notice.md
 *   npx tsx scripts/scenarist.mts --output=_workspace/03_news_scenario.md
 *   OPENCODE_MODEL=google/gemini-3.5-flash npx tsx scripts/scenarist.mts   # pick a different model
 */
import { createOpencode } from "@opencode-ai/sdk";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = process.cwd();
const WORK = path.join(ROOT, "_workspace");
const DEFAULT_INPUT = path.join(WORK, "01_notice.md");
const DEFAULT_OUTPUT = path.join(WORK, "03_news_scenario.md");

// Optional: "<provider>/<model>". Override via OPENCODE_MODEL or --model.
// opencode provider free-tier model (the previous deepseek-v4-flash-free was
// retired from the free tier). Override with OPENCODE_MODEL if needed.
// Example: "opencode/nemotron-3.5-lightning-free".
const DEFAULT_MODEL = process.env.OPENCODE_MODEL ?? "opencode/big-pickle";

function parseArgs(argv: string[]) {
  const args: { input: string; output: string; model: string } = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    model: DEFAULT_MODEL,
  };
  for (const a of argv) {
    if (a.startsWith("--input=")) args.input = a.slice("--input=".length);
    else if (a.startsWith("--output=")) args.output = a.slice("--output=".length);
    else if (a.startsWith("--model=")) args.model = a.slice("--model=".length);
  }
  return args;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function buildPrompt(noticeMarkdown: string): string {
  return [
    "You are the Scenarist agent for a university radio news program at Kyung Hee University.",
    "",
    "입력으로 주어지는 금주 공지사항을 읽고, 다음 원칙을 지켜 호스트(앵커) 1명과 리포터 1명의 radio news 시나리오를 한국어로 작성한다. 호스트와 리포터의 이름은 언급하지 않는다.",
    "",
    "## 작업 원칙",
    "1. **do not repeat** — 호스트와 리포터가 같은 내용을 반복하지 않도록 한다.",
    "2. **only readable texts** — 읽을 수 없는 텍스트는 시나리오에 가져오지 않는다.",
    "3. **all notices** — 모든 공지를 빠짐없이 포함한다. 공지가 많으면 뉴스 섹션(뉴스 1, 뉴스 2, ...)으로 묶어 정리한다.",
    "",
    "## 출력 형식 (반드시 아래 마크다운 구조)",
    "```",
    "# {YYYY년 M월 N째 주} 경희대학교 라디오 뉴스 시나리오",
    "",
    "> 근거 자료: `_workspace/01_notice.md`",
    "> 형식: 호스트(앵커) + 리포터 2인 라디오 뉴스",
    "",
    "## 오프닝",
    "**호스트:** ...",
    "**리포터:** ...",
    "",
    "## 뉴스 1 — {제목}",
    "**리포터:** ...",
    "**호스트:** ...",
    "...",
    "",
    "## 클로징",
    "**호스트:** ...",
    "**리포터:** ...",
    "**호스트:** ...",
    "```",
    "",
    "`_workspace/03_news_scenario.md` 파일에 결과를 작성하라. (파일 생성/쓰기 도구를 사용해 직접 작성)",
    "",
    "---",
    "아래는 이번 주 공지사항 원문이다.",
    "---",
    "",
    noticeMarkdown,
  ].join("\n");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. Read the notice file.
  let noticeMarkdown: string;
  try {
    noticeMarkdown = await fsp.readFile(args.input, "utf8");
  } catch (err) {
    console.error(`[scenarist] ERROR: cannot read input file: ${args.input}\n  ${err}`);
    process.exit(1);
  }
  if (!noticeMarkdown.trim()) {
    console.error(`[scenarist] ERROR: input file is empty: ${args.input}`);
    process.exit(1);
  }
  console.log(`[scenarist] read ${noticeMarkdown.length} chars from ${args.input}`);

  const [providerID, modelID] = args.model.split("/");
  if (args.model && (!providerID || !modelID)) {
    console.error(`[scenarist] ERROR: --model must be "<provider>/<model>", got "${args.model}"`);
    process.exit(1);
  }

  // 2. Boot an in-process opencode server and build a client.
  console.log("[scenarist] starting opencode server...");
  const { client, server } = await createOpencode();
  const session = client.session;

  try {
    // 3. Create a session rooted at the project (model is set at prompt time).
    const created = await session.create({
      body: { title: "Radio News — scenarist" },
      query: { directory: ROOT },
    });
    const sessionID = created.data?.id;
    if (!sessionID) {
      throw new Error(`session.create returned no session id: ${JSON.stringify(created)}`);
    }
    console.log(`[scenarist] session created: ${sessionID}`);

    // 4. Send the scenarist prompt (optionally with a target model).
    console.log(`[scenarist] sending scenarist prompt${args.model ? ` (${args.model})` : " (opencode default model)"}...`);
    const promptRes = await session.prompt({
      path: { id: sessionID },
      query: { directory: ROOT },
      body: {
        ...(args.model ? { model: { providerID, modelID } } : {}),
        parts: [{ type: "text", text: buildPrompt(noticeMarkdown) }],
      },
    });
    const messageID = promptRes.data?.info?.id;
    if (!messageID) {
      throw new Error(`session.prompt returned no message id: ${JSON.stringify(promptRes)}`);
    }
    console.log(`[scenarist] prompt accepted (message ${messageID}), waiting for completion...`);

    // 5. Wait for the assistant to finish (it writes the file via its tools).
    const deadline = Date.now() + 10 * 60 * 1000;
    const isDone = (r: { data?: { info?: { time?: { created: number; completed?: number } | { created: number } } } | null }) => {
      const t = r.data?.info?.time;
      return !!t && "completed" in t && typeof t.completed === "number";
    };
    let lastRes: Awaited<ReturnType<typeof session.message>> | undefined;
    while (Date.now() < deadline) {
      lastRes = await session.message({
        path: { id: sessionID, messageID },
        query: { directory: ROOT },
      });
      if (isDone(lastRes)) break;
      await sleep(1500);
    }
    if (!lastRes || !isDone(lastRes)) {
      throw new Error(`Timed out waiting for assistant message ${messageID} to complete`);
    }
    console.log("[scenarist] assistant finished.");

    // 6. Verify the output file exists.
    const out = args.output;
    let finalText: string;
    try {
      finalText = await fsp.readFile(out, "utf8");
    } catch {
      const entries = await fsp.readdir(WORK).catch(() => []);
      const candidates = entries.filter((f) => f.includes("scenario")).sort();
      if (candidates.length === 0) {
        throw new Error(`output not found at ${out} and no scenario file under ${WORK}`);
      }
      const fallback = path.join(WORK, candidates[0]);
      console.warn(`[scenarist] WARNING: ${out} not found; using ${fallback}`);
      finalText = await fsp.readFile(fallback, "utf8");
    }

    console.log(`[scenarist] DONE — wrote ${finalText.length} chars to ${out}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("[scenarist] FATAL:", err);
  process.exit(1);
});