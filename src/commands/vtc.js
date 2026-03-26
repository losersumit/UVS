const { supabase } = require("../stats_system/supabase");
const { getGuildConfig } = require("../stats_system/guildConfig");
const { isOwner } = require("../owner");

async function suspendvtc(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const targetId = interaction.options.getString("guild_id");
  const { error } = await supabase.from("approved_guilds").update({ is_suspended: true }).eq("guild_id", targetId);
  if (error) return interaction.editReply("❌ Failed to suspend VTC.");
  return interaction.editReply(`✅ Suspended VTC **${targetId}** from leaderboards.`);
}

async function restorevtc(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const targetId = interaction.options.getString("guild_id");
  const { error } = await supabase.from("approved_guilds").update({ is_suspended: false }).eq("guild_id", targetId);
  if (error) return interaction.editReply("❌ Failed to restore VTC.");
  return interaction.editReply(`✅ Restored VTC **${targetId}** to leaderboards.`);
}

module.exports = { suspendvtc, restorevtc };
