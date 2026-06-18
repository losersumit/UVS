/**
 * ============================================================================
 * MODULE: radioDirectory.js
 * PURPOSE: Manages the live Central Radio Directory embed on the NMC server.
 *          Refreshes frequencies on bot startup and VTC frequency changes.
 * ============================================================================
 */

const { EmbedBuilder } = require("discord.js");
const { supabase } = require("./supabase");

const DIRECTORY_GUILD_ID = "1448027116074434593";
const DIRECTORY_CHANNEL_ID = "1517168280475799604";
const DIRECTORY_TITLE = "📻  Central Radio Directory";

async function updateRadioDirectory(client) {
  try {
    // 1. Fetch all approved non-suspended VTCs from database
    const { data: guilds, error } = await supabase
      .from("approved_guilds")
      .select("guild_name, guild_tag, radio_frequency")
      .eq("is_suspended", false)
      .order("guild_name", { ascending: true });

    if (error) {
      console.error("[RadioDirectory] Failed to fetch VTC frequencies:", error);
      return;
    }

    // 2. Fetch the target channel
    const channel = await client.channels.fetch(DIRECTORY_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error("[RadioDirectory] Could not fetch target channel:", DIRECTORY_CHANNEL_ID);
      return;
    }

    // 3. Build directory description
    let description = "Below is the real-time frequency directory of all registered Virtual Trucking Companies (VTCs).\n\n";
    
    if (!guilds || guilds.length === 0) {
      description += "*No registered organisations found.*";
    } else {
      description += "```\n";
      description += `${"VTC Tag".padEnd(10)} | ${"VTC Name".padEnd(25)} | ${"Frequency".padEnd(12)}\n`;
      description += `${"-".repeat(10)}-+-${"-".repeat(25)}-+-${"-".repeat(12)}\n`;
      
      for (const g of guilds) {
        const tag = g.guild_tag || "N/A";
        const name = g.guild_name || "Unknown";
        let freqStr = "OFFLINE";
        if (g.radio_frequency !== null && g.radio_frequency !== undefined) {
          freqStr = `${parseFloat(g.radio_frequency).toFixed(2)} MHz`;
        }
        
        // Handle NMC's dual display in directory if needed, but normally just display its primary DB frequency
        description += `${tag.padEnd(10)} | ${name.substring(0, 25).padEnd(25)} | ${freqStr.padEnd(12)}\n`;
      }
      description += "```\n";
      
      description += "\n💡 **Note:** NMC always receives transmissions on **100.00 MHz** for Help & Support requests in addition to their custom tuned frequency.";
    }

    const embed = new EmbedBuilder()
      .setTitle(DIRECTORY_TITLE)
      .setDescription(description)
      .setColor(0xff7801)
      .setTimestamp()
      .setFooter({ text: "National Command Radio Operations" });

    // 4. Locate existing embed to edit
    let existingMsg = null;
    try {
      const messages = await channel.messages.fetch({ limit: 50 });
      existingMsg = messages.find(m => 
        m.author.id === client.user.id && 
        m.embeds.length > 0 && 
        m.embeds[0].title === DIRECTORY_TITLE
      );
    } catch (fetchErr) {
      console.error("[RadioDirectory] Failed to fetch channel messages:", fetchErr);
    }

    // 5. Send or Edit message
    if (existingMsg) {
      await existingMsg.edit({ embeds: [embed] });
      console.log("[RadioDirectory] Live radio directory embed updated.");
    } else {
      await channel.send({ embeds: [embed] });
      console.log("[RadioDirectory] Live radio directory embed created.");
    }

  } catch (err) {
    console.error("[RadioDirectory] Error updating radio directory:", err);
  }
}

module.exports = { updateRadioDirectory };
