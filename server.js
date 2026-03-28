require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { initDB } = require('./memory');
const { processMessage } = require('./agent-core');

const AUTHORIZED_USER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const app = express();

app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'orchestrator' }));

// Keep typing indicator alive during long operations
function startTyping(chatId) {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

// Send with Markdown, fall back to plain text if Telegram rejects the formatting
async function sendMessage(chatId, text) {
  const chunks = splitMessage(text, 4000);
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
    } catch {
      await bot.sendMessage(chatId, chunk);
    }
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1) splitAt = maxLen;

    chunks.push(remaining.substring(0, splitAt).trimEnd());
    remaining = remaining.substring(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

bot.on('message', async (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (userId !== AUTHORIZED_USER_ID) {
    console.log(`Blocked unauthorized user: ${userId}`);
    return;
  }

  if (!text) return;

  const stopTyping = startTyping(chatId);

  try {
    const response = await processMessage(text);
    stopTyping();
    await sendMessage(chatId, response || 'Done.');
  } catch (err) {
    stopTyping();
    console.error('Error processing message:', err);
    await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`Orchestrator running on port ${PORT}`);
      console.log(`Telegram bot active — authorized user: ${AUTHORIZED_USER_ID}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
