require('dns').setDefaultResultOrder('verbatim');
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_PRIVATE_URL || process.env.DATABASE_URL,
  ssl: process.env.DATABASE_PRIVATE_URL ? false : { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      key VARCHAR(255) NOT NULL,
      value TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(category, key)
    );

    CREATE TABLE IF NOT EXISTS action_history (
      id SERIAL PRIMARY KEY,
      action_type VARCHAR(100) NOT NULL,
      description TEXT,
      approved BOOLEAN,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS confidence_scores (
      action_type VARCHAR(100) PRIMARY KEY,
      approvals INTEGER DEFAULT 0,
      rejections INTEGER DEFAULT 0,
      total_executions INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}

async function saveMemory(category, key, value) {
  await pool.query(
    `INSERT INTO memories (category, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (category, key)
     DO UPDATE SET value = $3, updated_at = NOW()`,
    [category, key, value]
  );
}

async function searchMemories(query) {
  const { rows } = await pool.query(
    `SELECT category, key, value FROM memories
     WHERE key ILIKE $1 OR value ILIKE $1
     ORDER BY updated_at DESC
     LIMIT 20`,
    [`%${query}%`]
  );
  return rows;
}

async function getAllMemories() {
  const { rows } = await pool.query(
    'SELECT category, key, value FROM memories ORDER BY category, updated_at DESC'
  );
  return rows;
}

async function logAction(actionType, description, approved) {
  await pool.query(
    'INSERT INTO action_history (action_type, description, approved) VALUES ($1, $2, $3)',
    [actionType, description, approved]
  );

  if (approved !== null) {
    await pool.query(
      `INSERT INTO confidence_scores (action_type, approvals, rejections, total_executions)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (action_type) DO UPDATE SET
         approvals = confidence_scores.approvals + $2,
         rejections = confidence_scores.rejections + $3,
         total_executions = confidence_scores.total_executions + 1,
         updated_at = NOW()`,
      [actionType, approved ? 1 : 0, approved ? 0 : 1]
    );
  }
}

async function getConfidenceScores() {
  const { rows } = await pool.query(
    'SELECT action_type, approvals, rejections, total_executions FROM confidence_scores ORDER BY total_executions DESC'
  );
  return rows;
}

module.exports = { initDB, saveMemory, searchMemories, getAllMemories, logAction, getConfidenceScores };
