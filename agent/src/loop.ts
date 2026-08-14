// WHAT THIS FILE DOES: This is the agent's entry point and main loop. It
// wires up an OpenAI tool-use conversation, gives the model 4 tools (list
// tickets, search services, inspect a service, pay for a service, read the
// ledger), and runs turns until the model stops calling tools or MAX_TURNS
// is hit. `pay_for_service` is the only tool that spends money -- it's the
// only one that goes through t3n-client.ts / Terminal 3. Start reading here
// to understand the overall flow, then follow into src/tools/*.ts and
// src/t3n-client.ts.

// The autonomous agent: an OpenAI tool-use loop with 4 tools, deliberately
// asymmetric. search_services/inspect_service/get_ledger are free discovery;
// pay_for_service is the only tool that moves money, and it's the only one
// that talks to Terminal 3. This process holds an OpenAI key and its own
// Terminal 3 agent key (AGENT_KEY) -- nothing else. No Circle credential, no
// filesystem/shell tool, no ability to install anything at runtime (see
// SECURITY.md).
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { searchServices } from "./tools/searchServices.js";
import { inspectService } from "./tools/inspectService.js";
import { payForService } from "./tools/payForService.js";
import { getLedger } from "./tools/getLedger.js";
import { listFlaggedTickets } from "./tools/listFlaggedTickets.js";
import { emit } from "./events.js";

const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? "20");

// CUSTOMIZE: TASK is the agent's kickoff instruction -- the goal it's given
// when the loop starts. This (plus the system prompt down in main()) is the
// main thing to change if you're adapting this template to a different
// scenario/persona -- e.g. an on-call triage agent, a procurement agent, a
// research assistant -- swap out the wording here for your own use case.
//
// Enterprise support/trust-and-safety scenario: triage flagged tickets by
// verifying details via paid research services, escalating to a live phone
// call only when it's warranted and within the per-call cap. See
// docs/DEVELOPER_BUILD_LOG.md for the earlier crypto-research version this
// replaced (kept there as history, not rewritten to match).
//
// Same kickoff line as the dashboard chat's REPLAY_KICKOFF_PROMPT
// (dashboard/lib/replay-data.ts) -- deliberately doesn't say what "today's
// flagged tickets" are, same as an operator giving this instruction
// wouldn't either. That used to leave the live agent with nothing to act
// on (it correctly asked the operator for ticket details, then stopped);
// list_flagged_tickets below is what it now calls to find out, returning
// the same two tickets (#4821/#5390) the scripted replay narrates, so a
// live run and the demo replay tell the same story.
const TASK =
  process.env.AGENT_TASK ??
  "Keep an eye on flagged support tickets today. Verify what you can before acting, and call " +
    "to confirm if it's warranted -- check with me before anything above the usual per-call cap.";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see docs/DEVELOPER_BUILD_LOG.md §4)`);
  return value;
}

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_flagged_tickets",
      description: "List today's flagged support tickets awaiting triage. Free -- no money moves.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_services",
      description:
        "Search Circle's x402 paid-service marketplace by keyword. Free -- no money moves. " +
        "The marketplace indexes by service category, not by ticket topic -- search broad " +
        "terms like 'web search', 'research', or 'phone call' rather than paraphrasing what " +
        "the ticket needs verified (e.g. 'wire transfer verification' will return nothing).",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", description: "e.g. 'web search', 'research', 'phone call'" } },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_service",
      description:
        "Inspect a specific service URL to confirm its price, HTTP method, and schema before paying. Free -- no money moves.",
      parameters: {
        type: "object",
        properties: { service_url: { type: "string" } },
        required: ["service_url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pay_for_service",
      description:
        "Pay for a service and receive its response. The ONLY tool that spends money. Routes through a " +
        "Terminal 3 TEE contract that enforces a per-call cap and a session budget -- a call may be denied " +
        "with a policy_denied or egress_denied reason even if you request it correctly.",
      parameters: {
        type: "object",
        properties: {
          service_url: { type: "string" },
          method: { type: "string", description: "HTTP method from inspect_service's result, e.g. GET" },
          amount_usdc: {
            type: "number",
            description:
              "inspect_service's result.data.amount_usdc field -- already in whole USD dollars " +
              "(e.g. 0.54, not 540000). Never use a raw price.amount value directly; that's an " +
              "on-chain base-unit integer, not a dollar amount.",
          },
          payload: { type: "object", description: "request body/params, if any" },
        },
        required: ["service_url", "method", "amount_usdc"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ledger",
      description: "Read your own remaining session budget and full payment history so far.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  await emit({ type: "tool_call", tool: name, args });

  let result: unknown;
  switch (name) {
    case "list_flagged_tickets":
      result = await listFlaggedTickets();
      break;
    case "search_services":
      result = await searchServices(String(args.keyword));
      break;
    case "inspect_service":
      result = await inspectService(String(args.service_url));
      break;
    case "pay_for_service": {
      const payResult = await payForService({
        service_url: String(args.service_url),
        method: String(args.method),
        amount_usdc: Number(args.amount_usdc),
        payload: args.payload,
        idempotency_key: randomUUID(),
      });
      if ("authorized" in payResult && payResult.authorized) {
        await emit({
          type: "payment_approved",
          service_url: String(args.service_url),
          amount_usdc: Number(args.amount_usdc),
          remaining_budget: payResult.remaining_budget,
        });
      } else {
        // "error" comes from payForService.ts's catch block (a genuine thrown
        // fault); "reason" comes from a normal Ok-returning denial response
        // (policy_denied/relay_failed -- see t3n-client.ts's PayForServiceResult).
        const reason =
          "error" in payResult ? payResult.error : "reason" in payResult && payResult.reason ? payResult.reason : "denied";
        await emit({
          type: "payment_denied",
          service_url: String(args.service_url),
          amount_usdc: Number(args.amount_usdc),
          reason,
        });
      }
      result = payResult;
      break;
    }
    case "get_ledger":
      result = await getLedger();
      break;
    default:
      result = { error: `unknown tool: ${name}` };
  }

  await emit({ type: "tool_result", tool: name, result });
  return result;
}

// TASK's own wording ("...check with me before anything above the usual per-call cap")
// invites the model to stop and ask a question mid-run, same as the dashboard chat's
// AgentChat supports (operator replies feed back into the conversation there). This CLI
// loop used to have no equivalent -- whenever the model responded with no tool_calls
// (i.e. asked something instead of acting), it printed the message and exited
// immediately, with no way to actually answer it. `rl` below is what lets a reply typed
// at the terminal feed back in as the next user turn instead of ending the run there.
const rl = createInterface({ input: process.stdin, output: process.stdout });

function looksLikeExit(reply: string): boolean {
  return /^(exit|quit|stop|done|bye)$/i.test(reply.trim());
}

async function main() {
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are an autonomous support-triage agent with a Circle-powered USDC wallet, guarded " +
        "by a Terminal 3 enclave you cannot bypass. Start by listing today's flagged tickets, " +
        "then use search_services for each one -- search by service category (e.g. 'web " +
        "search', 'research', 'phone call'), not by paraphrasing the ticket's own wording, " +
        "since the marketplace indexes by what a service does, not what a ticket needs. Every " +
        "payment is checked against a spend policy you don't control and can't see in advance -- " +
        "treat denials as normal, not errors, and adapt.",
    },
    { role: "user", content: TASK },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
      });

      const choice = completion.choices[0];
      const message = choice.message;

      if (message.content) {
        await emit({ type: "thinking", text: message.content });
      }

      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        console.log("\n=== Agent ===\n" + (message.content ?? ""));
        const reply = await rl.question("\n(reply to continue, or press Enter/type 'exit' to end)\n> ").catch(() => "");
        if (!reply.trim() || looksLikeExit(reply)) {
          console.log("\n=== Session ended ===");
          return;
        }
        await emit({ type: "user_reply", text: reply.trim() });
        messages.push({ role: "user", content: reply.trim() });
        continue;
      }

      for (const toolCall of message.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments || "{}");
        const result = await callTool(toolCall.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    console.log(`\n=== Stopped after ${MAX_TURNS} turns without a final answer ===`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
