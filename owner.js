// .uvs/owner.js
// Absolute owner of the bot (YOU)

const BOT_OWNER_ID = process.env.BOT_OWNER_ID;

if (!BOT_OWNER_ID) {
  throw new Error("❌ Missing BOT_OWNER_ID env var");
}

function isOwner(userId) {
  return userId === BOT_OWNER_ID;
}

module.exports = { BOT_OWNER_ID, isOwner };
