require('dotenv').config();
const axios = require('axios');

async function callZohoAgent(question) {
  try {
    const res = await axios.post(
      `${process.env.ZOHO_AGENT_URL}/query`,
      { question, token: process.env.ZOHO_AGENT_TOKEN },
      { timeout: 45000 }
    );
    return res.data.response || 'Zoho agent returned no response.';
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    return `Zoho agent error: ${msg}`;
  }
}

async function callMotionAgent(question) {
  try {
    const res = await axios.post(
      `${process.env.MOTION_AGENT_URL}/query`,
      { question },
      {
        headers: { 'x-auth-token': process.env.MOTION_AGENT_TOKEN },
        timeout: 45000
      }
    );
    return res.data.response || 'Motion agent returned no response.';
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    return `Motion agent error: ${msg}`;
  }
}

module.exports = { callZohoAgent, callMotionAgent };
