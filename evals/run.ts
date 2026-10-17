// Runs the Bellevue test calls through the real API (the same endpoint Vapi calls) in test mode, scores them, and
// writes a report.
//
//   npm run eval                                   # against the deployed app
//   npm run eval -- --target http://localhost:3000 # against a local server (npm run build && npm start)
//   npm run eval -- --only routing                 # scenarios whose id or requirement contains "routing"
//   npm run eval -- --no-judge --concurrency 6
//
// Needs VAPI_LLM_SECRET (the endpoint's secret) and OPENAI_API_KEY (for simulated callers and the judge),
// read from .env.local.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scenarios, type Expect, type Scenario } from "./scenarios";

type ToolTrace = { name: string; ms: number; ok: boolean; args?: Record<string, unknown>; result?: Record<string, unknown> };
type Trace = { path: string; ms: number; tools: ToolTrace[]; gates?: { id: string; yes: boolean; confidence: number }[] };
type Turn = { caller: string; reply: string; ms: number; trace?: Trace };
type Check = { name: string; pass: boolean; detail?: string };
type Outcome = { scenario: Scenario; turns: Turn[]; checks: Check[]; error?: string };

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const TARGET = (arg("target") ?? process.env.EVAL_TARGET ?? "https://cityagent.vercel.app").replace(/\/$/, "");
const ONLY = arg("only"), JUDGE = !process.argv.includes("--no-judge"), CONCURRENCY = Number(arg("concurrency") ?? 4);
const CALLER_MODEL = process.env.EVAL_CALLER_MODEL ?? "gpt-4.1-mini", JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "gpt-4.1";
const GREETING = "Welcome to Bellevue CityDesk. How can I help you today?";
const { VAPI_LLM_SECRET: SECRET, OPENAI_API_KEY: OPENAI_KEY } = process.env;
if (!SECRET) { console.error("VAPI_LLM_SECRET is not set (run via npm run eval, which reads .env.local)."); process.exit(1); }

async function openai(body: object): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).choices[0].message.content ?? "";
}

// One turn through the API, exactly as Vapi would send it, plus the test-mode headers.
async function agentTurn(scenario: Scenario, conversation: string, messages: { role: string; content: string }[]): Promise<Turn> {
  const started = Date.now();
  const res = await fetch(`${TARGET}/api/vapi/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", "x-cityagent-test": conversation, "x-cityagent-now": scenario.at },
    body: JSON.stringify({ model: "cityagent", stream: false, messages: [{ role: "system", content: "CityDesk" }, ...messages], ...(scenario.callerNumber && { call: { customer: { number: scenario.callerNumber } } }) }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const body = await res.json();
  return { caller: messages[messages.length - 1].content, reply: body.choices?.[0]?.message?.content ?? "", ms: Date.now() - started, trace: body.cityagent };
}

// A model plays the resident, with a goal, and says only their next line.
async function simulatedCaller(goal: string, turns: Turn[]): Promise<string> {
  const transcript = [`Receptionist: ${GREETING}`, ...turns.flatMap(t => [`You: ${t.caller}`, `Receptionist: ${t.reply}`])].join("\n");
  return (await openai({ model: CALLER_MODEL, temperature: 0.3, max_tokens: 90, messages: [
    { role: "system", content: `You are a resident phoning the City of Bellevue's phone line. ${goal} Reply with only what you say next: one or two short, casual spoken sentences. Give details when asked. When your goal is done and they ask if there's anything else, say no thanks and goodbye. If they already said goodbye, reply exactly: [hangs up]` },
    { role: "user", content: `${transcript}\n\nWhat do you say next?` },
  ] })).trim();
}

async function play(scenario: Scenario): Promise<Turn[]> {
  const conversation = `eval-${scenario.id}-${Date.now().toString(36)}`, turns: Turn[] = [];
  const messages = [{ role: "assistant", content: GREETING }];
  for (let i = 0; i < (scenario.turns?.length ?? 8); i++) {
    const said = scenario.turns ? scenario.turns[i] : await simulatedCaller(scenario.caller!, turns);
    if (said.includes("[hangs up]")) break;
    messages.push({ role: "user", content: said });
    const turn = await agentTurn(scenario, conversation, messages);
    turns.push(turn);
    messages.push({ role: "assistant", content: turn.reply });
    if (!scenario.turns && /goodbye|9 1 1/i.test(turn.reply)) break;
  }
  return turns;
}

// What the agent did, from the traces of every turn.
function outcomes(turns: Turn[]) {
  const calls = turns.flatMap(t => t.trace?.tools ?? []);
  const done = (name: string, flag: string) => calls.filter(c => c.name === name && c.result?.[flag] === true);
  return {
    calls,
    tickets: done("create_ticket", "created").map(c => c.args ?? {}),
    transfers: done("transfer_call", "transferred").map(c => c.args ?? {}),
    followed: done("follow_ticket", "added").map(c => (c.result?.ticket as { reference?: string })?.reference),
    known: calls.filter(c => c.name === "find_known_issue" && c.result?.known === true).map(c => c.result?.source as string),
  };
}

async function judge(scenario: Scenario, turns: Turn[], rubric: string): Promise<Check> {
  const transcript = turns.map(t => `Caller: ${t.caller}\nAgent: ${t.reply}`).join("\n");
  const tools = turns.flatMap(t => t.trace?.tools ?? []).map(c => `- ${c.name}(${JSON.stringify(c.args ?? {})}) → ${JSON.stringify(c.result ?? {}).slice(0, 1500)}`).join("\n") || "(none)";
  const raw = await openai({ model: JUDGE_MODEL, temperature: 0, response_format: { type: "json_object" }, messages: [
    { role: "system", content: "You grade a call to a city's AI phone receptionist against a rubric. Reply with JSON: {\"pass\": true|false, \"reason\": \"one sentence\"}. Pass only if the rubric is fully met; judge substance, not wording. Facts that appear in the agent's tool results (shown below) or in the city's published information are not invented; only count something as invented if nothing supports it." },
    { role: "user", content: `Simulated time: ${scenario.at} (Bellevue). Rubric: ${rubric}\n\nTranscript:\n${transcript}\n\nTool calls:\n${tools}` },
  ] });
  const verdict = JSON.parse(raw) as { pass: boolean; reason: string };
  return { name: "judge", pass: verdict.pass, detail: verdict.reason };
}

async function score(scenario: Scenario, turns: Turn[]): Promise<Check[]> {
  const e: Expect = scenario.expect, o = outcomes(turns), replies = turns.map(t => t.reply), checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });
  // Every call: an answer each turn, no server error, no web address read aloud.
  add("answered every turn", turns.length > 0 && replies.every(r => r.trim() && !/something went wrong on my side/i.test(r)));
  add("no URL read aloud", !replies.some(r => /https?:|www\.|\.(gov|com|org)\b/i.test(r)));
  // Replies are formatted for speech ("4 2 5, 4 5 2, 4 7 6 2"), so patterns are also tried with digit groups joined.
  const joined = (r: string) => r.replace(/(?<=\d)[ ,]+(?=\d)/g, "");
  for (const re of e.says ?? []) add(`says ${re}`, replies.some(r => re.test(r) || re.test(joined(r))));
  for (const re of e.saysNot ?? []) add(`never says ${re}`, !replies.some(r => re.test(r) || re.test(joined(r))));
  for (const name of e.tools ?? []) add(`calls ${name}`, o.calls.some(c => c.name === name && c.ok));
  const ticket = e.ticket, transfer = e.transfer;
  if (ticket === false) add("no ticket created", !o.tickets.length, o.tickets.length ? JSON.stringify(o.tickets[0]) : undefined);
  else if (ticket) add(`ticket for ${ticket.department}${ticket.location ? ` at ${ticket.location}` : ""}`,
    o.tickets.some(t => t.department === ticket.department && (!ticket.location || ticket.location.test(String(t.location)))),
    o.tickets.map(t => JSON.stringify(t)).join("; ") || "none created");
  if (transfer === false) add("not transferred", !o.transfers.length, o.transfers.map(t => String(t.department)).join(", ") || undefined);
  else if (transfer) add(`transferred to ${transfer.department}`, o.transfers.some(t => t.department === transfer.department), o.transfers.map(t => String(t.department)).join(", ") || "no transfer");
  if (e.known === false) add("not matched to a known issue", !o.known.length);
  else if (e.known) add(`matched a known issue (${e.known})`, o.known.includes(e.known), o.known.join(", ") || "no match");
  if (e.followed) add(`caller added to ${e.followed}`, o.followed.includes(e.followed), o.followed.join(", ") || "not added");
  if (e.gate) add(`turn ${e.gate} answered by a gate`, turns[e.gate - 1]?.trace?.path === "gate", turns[e.gate - 1]?.trace?.path);
  if (e.judge && JUDGE) checks.push(await judge(scenario, turns, e.judge).catch(err => ({ name: "judge", pass: false, detail: `judge failed: ${err}` })));
  return checks;
}

async function runOne(scenario: Scenario): Promise<Outcome> {
  try {
    const turns = await play(scenario);
    return { scenario, turns, checks: await score(scenario, turns) };
  } catch (err) {
    return { scenario, turns: [], checks: [{ name: "ran", pass: false, detail: String(err) }], error: String(err) };
  }
}

function report(results: Outcome[], seconds: number): string {
  const passed = (r: Outcome) => r.checks.every(c => c.pass);
  const turns = results.flatMap(r => r.turns), serverMs = turns.map(t => t.trace?.ms ?? t.ms).sort((a, b) => a - b);
  const pct = (p: number) => serverMs.length ? (serverMs[Math.min(serverMs.length - 1, Math.floor(p * serverMs.length))] / 1000).toFixed(1) : "-";
  const byRequirement = [...new Set(results.map(r => r.scenario.requirement))].map(req => {
    const rs = results.filter(r => r.scenario.requirement === req);
    return `| ${req} | ${rs.filter(passed).length} / ${rs.length} | ${rs.filter(r => !passed(r)).map(r => r.scenario.id).join(", ") || "—"} |`;
  });
  const block = (r: Outcome) => [
    `### ${passed(r) ? "✅" : "❌"} ${r.scenario.id} — ${r.scenario.title}`,
    "",
    `_${r.scenario.requirement} · simulated time ${r.scenario.at}${r.scenario.callerNumber ? ` · caller ID ${r.scenario.callerNumber}` : " · web call"}${r.scenario.caller ? " · simulated caller" : ""}_`,
    "",
    ...r.checks.map(c => `- ${c.pass ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`),
    "",
    "<details><summary>Transcript</summary>",
    "",
    ...r.turns.flatMap(t => [`**Caller:** ${t.caller}`, "", `**CityDesk** _(${((t.trace?.ms ?? t.ms) / 1000).toFixed(1)}s, ${t.trace?.path ?? "?"}${t.trace?.tools?.length ? `; ${t.trace.tools.map(c => c.name).join(", ")}` : ""})_: ${t.reply}`, ""]),
    "</details>",
    "",
  ].join("\n");
  return [
    `# CityDesk evaluation — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Target \`${TARGET}\` in test mode · ${results.length} scenarios, ${turns.length} turns, ${seconds.toFixed(0)}s · judge ${JUDGE ? JUDGE_MODEL : "off"} · simulated callers ${CALLER_MODEL}`,
    "",
    `**${results.filter(passed).length} / ${results.length} scenarios passed** · ${results.flatMap(r => r.checks).filter(c => c.pass).length} / ${results.flatMap(r => r.checks).length} checks · server time per turn: median ${pct(0.5)}s, 90th percentile ${pct(0.9)}s`,
    "",
    "| Requirement | Passed | Failing |",
    "|---|---|---|",
    ...byRequirement,
    "",
    ...results.filter(r => !passed(r)).map(block),
    ...results.filter(passed).map(block),
  ].join("\n");
}

async function main() {
  const selected = scenarios.filter(s => !ONLY || s.id.includes(ONLY) || s.requirement.includes(ONLY));
  console.log(`Running ${selected.length} scenarios against ${TARGET} (concurrency ${CONCURRENCY}, judge ${JUDGE ? JUDGE_MODEL : "off"})\n`);
  const started = Date.now(), results: Outcome[] = new Array(selected.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < selected.length) {
      const i = next++, r = await runOne(selected[i]);
      results[i] = r;
      const failed = r.checks.filter(c => !c.pass);
      console.log(`${failed.length ? "✗" : "✓"} ${r.scenario.id.padEnd(28)} ${r.turns.length} turn(s)${failed.length ? `  — ${failed.map(c => c.name + (c.detail ? ` (${c.detail.slice(0, 90)})` : "")).join("; ")}` : ""}`);
    }
  }));
  const markdown = report(results, (Date.now() - started) / 1000);
  const dir = path.join(process.cwd(), "evals/reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  writeFileSync(path.join(dir, `${stamp}.md`), markdown);
  writeFileSync(path.join(dir, "latest.md"), markdown);
  const passedCount = results.filter(r => r.checks.every(c => c.pass)).length;
  console.log(`\n${passedCount} / ${results.length} scenarios passed. Report: evals/reports/latest.md`);
  process.exitCode = passedCount === results.length ? 0 : 1;
}

main();
