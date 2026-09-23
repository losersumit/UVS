// stats_system/unbService.js
// Service for communicating with UnbelievaBoat (UNB) REST API

const axios = require("axios");

const UNB_API_BASE = "https://unbelievaboat.com/api/v1";

/**
 * Add or adjust bank balance for a user in a specific guild on UnbelievaBoat
 * @param {string} guildId - Discord Guild ID
 * @param {string} userId - Discord User ID
 * @param {number} amount - Amount of money to add (positive) or deduct (negative) to Bank
 * @param {string} [reason="UVS Job Log Payout"] - Audit log reason
 * @returns {Promise<Object|null>} Response data from UnbelievaBoat API or null on error
 */
async function addUnbBank(guildId, userId, amount, reason = "UVS Job Log Payout") {
  const token = process.env.UNB_TOKEN;
  if (!token) {
    console.error("[UNB_API] Missing UNB_TOKEN in environment.");
    return null;
  }

  const bankAmount = Math.round(amount);
  if (isNaN(bankAmount) || bankAmount <= 0) {
    console.warn(`[UNB_API] Invalid or zero bank amount (${amount}) for user ${userId} in guild ${guildId}`);
    return null;
  }

  const url = `${UNB_API_BASE}/guilds/${guildId}/users/${userId}`;

  try {
    const response = await axios.patch(
      url,
      {
        bank: bankAmount,
        reason: reason
      },
      {
        headers: {
          Authorization: token,
          "Content-Type": "application/json"
        },
        timeout: 10000
      }
    );

    console.log(`[UNB_API] Successfully added $${bankAmount} to Bank for user ${userId} in guild ${guildId}`);
    return response.data;
  } catch (err) {
    const status = err.response ? err.response.status : "NETWORK_ERROR";
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[UNB_API_ERROR] Failed to update bank balance for user ${userId} in guild ${guildId} [Status: ${status}]:`, detail);
    return null;
  }
}

// Alias for backwards compatibility
const addUnbCash = addUnbBank;

module.exports = { addUnbBank, addUnbCash };

