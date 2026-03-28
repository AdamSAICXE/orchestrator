require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { getAllMemories, searchMemories, saveMemory, logAction, getConfidenceScores } = require('./memory');
const { callZohoAgent, callMotionAgent } = require('./sub-agents');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_HISTORY = 20;
const MAX_ITERATIONS = 15;

// Single-user session state
const state = {
  history: [],
  pendingApproval: null // { messages, blockId, actionTypes, systemPrompt }
};

const TOOLS = [
  {
    name: 'ask_zoho_agent',
    description: 'Send a natural language request to the Zoho agent. Handles CRM contacts, deals, notes, activities, Desk tickets, and Flow workflows. Supports both reads and writes.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language request for the Zoho agent' }
      },
      required: ['question']
    }
  },
  {
    name: 'ask_motion_agent',
    description: 'Send a natural language request to the Motion agent. Handles tasks and projects — listing, creating, updating, and deleting.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural language request for the Motion agent' }
      },
      required: ['question']
    }
  },
  {
    name: 'draft_email',
    description: 'Compose an email draft for the user to review. This NEVER sends the email — it only formats a draft. Always use this instead of any send action.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address or name' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body (plain text or light markdown)' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'remember',
    description: 'Save a preference, account note, or learned behavior to persistent memory. Use this proactively when you learn something worth keeping.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['preference', 'account_context', 'behavior'],
          description: 'preference = how the user likes things done; account_context = facts about specific accounts/contacts; behavior = learned workflow patterns'
        },
        key: { type: 'string', description: 'Short identifier, e.g. "acme_main_contact" or "task_creation_preference"' },
        value: { type: 'string', description: 'The value to store' }
      },
      required: ['category', 'key', 'value']
    }
  },
  {
    name: 'recall',
    description: 'Search persistent memory for stored preferences, account context, or learned behaviors.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, e.g. "Acme" or "email preference"' }
      },
      required: ['query']
    }
  },
  {
    name: 'show_plan',
    description: 'Present a numbered plan to the user and pause for their approval before executing any write actions. Use when taking write actions for the first time or when the pattern is unfamiliar. Do NOT use for read-only requests.',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'array',
          items: { type: 'string' },
          description: 'Steps you plan to take, in order'
        },
        action_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Action type identifiers for confidence tracking, e.g. ["create_motion_task", "add_zoho_note"]'
        }
      },
      required: ['plan', 'action_types']
    }
  }
];

function buildSystemPrompt(memories, confidenceScores) {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  let memorySection = '';
  if (memories.length > 0) {
    const byCategory = {};
    for (const m of memories) {
      if (!byCategory[m.category]) byCategory[m.category] = [];
      byCategory[m.category].push(`  ${m.key}: ${m.value}`);
    }
    memorySection = '\n\nMEMORY:\n' +
      Object.entries(byCategory)
        .map(([cat, items]) => `[${cat.toUpperCase()}]\n${items.join('\n')}`)
        .join('\n\n');
  }

  let confidenceSection = '';
  if (confidenceScores.length > 0) {
    const lines = confidenceScores.map(s => {
      const rate = s.total_executions > 0
        ? Math.round((s.approvals / s.total_executions) * 100)
        : 0;
      return `  ${s.action_type}: ${s.approvals}/${s.total_executions} approvals (${rate}%)`;
    });
    confidenceSection = '\n\nCONFIDENCE SCORES (approvals/total):\n' + lines.join('\n');
  }

  return `You are a personal AI orchestrator for an Account Manager / Customer Experience professional. You coordinate Zoho CRM/Desk/Flow and Motion task management on their behalf.

Today is ${date}.

TOOLS:
- ask_zoho_agent: Zoho CRM contacts/deals/notes/activities, Desk tickets, Flow workflows. Read + write.
- ask_motion_agent: Motion tasks and projects. Read + write.
- draft_email: Compose email drafts only — NEVER sends.
- remember: Save preferences, account context, or learned behaviors to persistent memory.
- recall: Search persistent memory.
- show_plan: Present your plan to the user and wait for approval before executing writes.

HARD RULES — never violate:
1. Email is draft-only. Never send emails or ask sub-agents to send them.
2. Never make purchases, authorize payments, or take any financial action.
3. Only communicate with the authorized user via Telegram. Never initiate contact with anyone else.
4. Only act on behalf of the authorized user.

AUTONOMY MODEL:
- Read-only actions: execute directly, no plan needed.
- Write actions with no prior history (new pattern): call show_plan first.
- Write actions with established confidence (5+ approvals, 80%+ approval rate): execute and report.
- After executing, clearly state what was done.
- Use remember proactively to save useful context you learn about accounts, contacts, or preferences.

RESPONSE STYLE:
- Concise and direct.
- Numbered lists for plans, bullet points for results.
- When reporting execution, lead with what was done.
- When uncertain about intent, ask one clarifying question.
${memorySection}${confidenceSection}`;
}

async function executeTool(name, input) {
  switch (name) {
    case 'ask_zoho_agent':
      return await callZohoAgent(input.question);

    case 'ask_motion_agent':
      return await callMotionAgent(input.question);

    case 'draft_email':
      return [
        '--- EMAIL DRAFT ---',
        `To: ${input.to}`,
        `Subject: ${input.subject}`,
        '',
        input.body,
        '--- END DRAFT ---',
        '',
        'This is a draft only. Not sent.'
      ].join('\n');

    case 'remember':
      await saveMemory(input.category, input.key, input.value);
      return `Saved to memory: [${input.category}] ${input.key}`;

    case 'recall': {
      const results = await searchMemories(input.query);
      if (results.length === 0) return 'No matching memories found.';
      return results.map(r => `[${r.category}] ${r.key}: ${r.value}`).join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

async function runAgentLoop(messages, systemPrompt) {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text')?.text || '';
      updateHistory(messages);
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      let planTool = null;

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'show_plan') {
          planTool = block;
          break; // show_plan always interrupts — skip any other tools in this batch
        }

        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }

      if (planTool) {
        const { plan, action_types } = planTool.input;

        // Store messages for resumption (does not yet include the tool result)
        state.pendingApproval = {
          messages: [...messages],
          blockId: planTool.id,
          actionTypes: action_types || [],
          systemPrompt
        };

        return formatPlan(plan);
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  return 'Reached maximum steps. Please try a simpler request.';
}

function formatPlan(steps) {
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `Here's my plan:\n\n${numbered}\n\nReply *go* to proceed, or tell me to adjust anything.`;
}

function updateHistory(messages) {
  // Only save clean text exchanges — tool_use/tool_result pairs are session-only
  // and cannot be safely replayed as history in future turns
  const clean = [];
  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      clean.push(msg);
    } else if (msg.role === 'assistant') {
      const textBlock = Array.isArray(msg.content)
        ? msg.content.find(b => b.type === 'text')
        : null;
      const text = typeof msg.content === 'string' ? msg.content : textBlock?.text;
      if (text) clean.push({ role: 'assistant', content: text });
    }
  }
  state.history = clean.slice(-MAX_HISTORY);
}

async function processMessage(text) {
  const normalized = text.trim().toLowerCase();

  // Handle pending approval response
  if (state.pendingApproval) {
    if (['go', 'yes', 'y', 'proceed', 'ok', 'okay', 'do it'].includes(normalized)) {
      const { messages, blockId, actionTypes, systemPrompt } = state.pendingApproval;
      state.pendingApproval = null;

      for (const t of actionTypes) {
        await logAction(t, 'user approved plan', true);
      }

      // Resume the agent loop from after the show_plan tool call
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: blockId,
          content: 'User approved the plan. Proceed with execution.'
        }]
      });

      return await runAgentLoop(messages, systemPrompt);
    }

    if (['no', 'cancel', 'stop', 'nope'].includes(normalized)) {
      const { actionTypes } = state.pendingApproval;
      for (const t of actionTypes) {
        await logAction(t, 'user rejected plan', false);
      }
      state.pendingApproval = null;
      return 'Cancelled. What would you like to do differently?';
    }

    // Any other message = new instruction, cancel pending
    state.pendingApproval = null;
  }

  // Load fresh context for each message
  const [memories, confidenceScores] = await Promise.all([
    getAllMemories(),
    getConfidenceScores()
  ]);
  const systemPrompt = buildSystemPrompt(memories, confidenceScores);

  const messages = [
    ...state.history,
    { role: 'user', content: text }
  ];

  return await runAgentLoop(messages, systemPrompt);
}

module.exports = { processMessage };
