/**
 * ============================================================================
 * MODULE: owner.js
 * PURPOSE: A simple utility module to verify if a given Discord user ID 
 *          matches the hardcoded bot owner ID. Used to lock powerful commands.
 * ============================================================================
 */
// .uvs/src/owner.js
// Handles Owner-Only permissions

const process = require('process');

function isOwner(userId) {
    const ownerId = process.env.OWNER_ID || "739327867200274473"; // Your user ID
    return userId === ownerId;
}

module.exports = { isOwner };
