// src/stats_system/surveillanceService.js
const { supabase } = require("./supabase");

/**
 * Helper to get the guild tag for a given guild ID.
 */
async function getGuildTag(guildId) {
  const { data, error } = await supabase
    .from("approved_guilds")
    .select("guild_tag")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return data.guild_tag;
}

/**
 * Handles a member joining an approved guild.
 */
async function handleMemberJoin(member) {
  if (member.user.bot) return;

  const guildTag = await getGuildTag(member.guild.id);
  if (!guildTag) return; // Not an approved guild

  const discordId = member.id;
  const username = member.user.username;
  const joinedAt = member.joinedAt ? member.joinedAt.toISOString() : new Date().toISOString();

  console.log(`👤 [Surveillance] Member joined: ${username} (${discordId}) -> ${guildTag}`);

  try {
    const { data: existing, error: fetchError } = await supabase
      .from("member_surveillance")
      .select("*")
      .eq("discord_id", discordId)
      .maybeSingle();

    if (fetchError) {
      console.error(`❌ [Surveillance] Error fetching member ${discordId}:`, fetchError);
      return;
    }

    if (!existing) {
      // New member row
      const { error: insertError } = await supabase
        .from("member_surveillance")
        .insert({
          discord_id: discordId,
          username: username,
          current_guild: { tag: guildTag, joined_at: joinedAt },
          previous_guilds: []
        });

      if (insertError) {
        console.error(`❌ [Surveillance] Error inserting new member ${discordId}:`, insertError);
      }
    } else {
      // Member exists
      const current = existing.current_guild;
      let previous = existing.previous_guilds || [];
      if (!Array.isArray(previous)) previous = [];

      let updatedCurrent = current;
      let updatedPrevious = [...previous];

      if (!current) {
        updatedCurrent = { tag: guildTag, joined_at: joinedAt };
      } else if (current.tag !== guildTag) {
        // Move current guild to previous_guilds
        const archivedGuild = {
          tag: current.tag,
          joined_at: current.joined_at,
          left_at: new Date().toISOString()
        };
        updatedPrevious.push(archivedGuild);
        updatedCurrent = { tag: guildTag, joined_at: joinedAt };
      }

      const { error: updateError } = await supabase
        .from("member_surveillance")
        .update({
          username: username,
          current_guild: updatedCurrent,
          previous_guilds: updatedPrevious
        })
        .eq("discord_id", discordId);

      if (updateError) {
        console.error(`❌ [Surveillance] Error updating member ${discordId}:`, updateError);
      }
    }
  } catch (err) {
    console.error(`❌ [Surveillance] Fatal error handling join for ${discordId}:`, err);
  }
}

/**
 * Handles a member leaving an approved guild.
 */
async function handleMemberLeave(member) {
  if (member.user.bot) return;

  const guildTag = await getGuildTag(member.guild.id);
  if (!guildTag) return; // Not an approved guild

  const discordId = member.id;
  const username = member.user.username;

  console.log(`👤 [Surveillance] Member left: ${username} (${discordId}) -> ${guildTag}`);

  try {
    const { data: existing, error: fetchError } = await supabase
      .from("member_surveillance")
      .select("*")
      .eq("discord_id", discordId)
      .maybeSingle();

    if (fetchError) {
      console.error(`❌ [Surveillance] Error fetching member ${discordId}:`, fetchError);
      return;
    }

    if (existing) {
      const current = existing.current_guild;
      let previous = existing.previous_guilds || [];
      if (!Array.isArray(previous)) previous = [];

      if (current && current.tag === guildTag) {
        // Move current to previous
        const archivedGuild = {
          tag: current.tag,
          joined_at: current.joined_at,
          left_at: new Date().toISOString()
        };
        const updatedPrevious = [...previous, archivedGuild];

        const { error: updateError } = await supabase
          .from("member_surveillance")
          .update({
            username: username,
            current_guild: null,
            previous_guilds: updatedPrevious
          })
          .eq("discord_id", discordId);

        if (updateError) {
          console.error(`❌ [Surveillance] Error updating member ${discordId} on leave:`, updateError);
        }
      }
    }
  } catch (err) {
    console.error(`❌ [Surveillance] Fatal error handling leave for ${discordId}:`, err);
  }
}

/**
 * Synchronizes database records with all current members across all approved guilds.
 */
async function syncAllMembers(client) {
  console.log("🔄 [Surveillance] Starting full member sync...");
  try {
    // 1. Fetch approved guilds
    const { data: approvedGuilds, error: guildError } = await supabase
      .from("approved_guilds")
      .select("guild_id, guild_tag");

    if (guildError || !approvedGuilds) {
      console.error("❌ [Surveillance] Error fetching approved guilds:", guildError);
      return;
    }

    const guildTagMap = new Map(approvedGuilds.map(g => [g.guild_id, g.guild_tag]));

    // 2. Fetch existing surveillance records
    const { data: existingRecords, error: recordError } = await supabase
      .from("member_surveillance")
      .select("*");

    if (recordError) {
      console.error("❌ [Surveillance] Error fetching member_surveillance records:", recordError);
      return;
    }

    const surveillanceMap = new Map((existingRecords || []).map(r => [r.discord_id, r]));

    // 3. Scan all members in all approved guilds
    // Group active memberships by user ID
    const userActiveGuilds = new Map(); // discord_id -> Array of { guildTag, joinedAt, username }

    for (const [guildId, guildTag] of guildTagMap) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        console.log(`⚠️ [Surveillance] Could not fetch guild: ${guildId}`);
        continue;
      }

      const members = await guild.members.fetch().catch(err => {
        console.error(`⚠️ [Surveillance] Could not fetch members for guild ${guild.name} (${guildId}):`, err.message);
        return null;
      });

      if (!members) continue;

      for (const [memberId, member] of members) {
        if (member.user.bot) continue;

        const joinedAt = member.joinedAt ? member.joinedAt.toISOString() : new Date().toISOString();
        if (!userActiveGuilds.has(memberId)) {
          userActiveGuilds.set(memberId, []);
        }
        userActiveGuilds.get(memberId).push({
          tag: guildTag,
          joined_at: joinedAt,
          username: member.user.username
        });
      }
    }

    console.log(`🔍 [Surveillance] Scanned ${userActiveGuilds.size} unique active members.`);

    // 4. Update the database for all scanned users
    let inserts = 0;
    let updates = 0;

    for (const [discordId, activeGuildList] of userActiveGuilds) {
      // Sort active guilds by join date ascending
      activeGuildList.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at));

      // The latest join date guild is the current guild
      const primaryGuild = activeGuildList[activeGuildList.length - 1];
      const otherGuilds = activeGuildList.slice(0, -1);

      const existing = surveillanceMap.get(discordId);

      if (!existing) {
        // Create new record
        // Any secondary guilds the user is in are immediately added as previous/historical
        const previousList = otherGuilds.map(g => ({
          tag: g.tag,
          joined_at: g.joined_at,
          left_at: new Date().toISOString() // Marked as left current tracking
        }));

        const { error: insErr } = await supabase
          .from("member_surveillance")
          .insert({
            discord_id: discordId,
            username: primaryGuild.username,
            current_guild: { tag: primaryGuild.tag, joined_at: primaryGuild.joined_at },
            previous_guilds: previousList
          });

        if (insErr) {
          console.error(`❌ [Surveillance] Insert failed for ${discordId}:`, insErr);
        } else {
          inserts++;
        }
      } else {
        // Update existing record
        const current = existing.current_guild;
        let previous = existing.previous_guilds || [];
        if (!Array.isArray(previous)) previous = [];

        let updatedCurrent = current;
        let updatedPrevious = [...previous];

        if (!current) {
          // If no current guild stored, set it to the primary active guild
          updatedCurrent = { tag: primaryGuild.tag, joined_at: primaryGuild.joined_at };
          // Add any secondary guilds to previous if they are not already logged
          for (const sg of otherGuilds) {
            if (!updatedPrevious.some(p => p.tag === sg.tag && p.joined_at === sg.joined_at)) {
              updatedPrevious.push({
                tag: sg.tag,
                joined_at: sg.joined_at,
                left_at: new Date().toISOString()
              });
            }
          }
        } else if (current.tag !== primaryGuild.tag) {
          // If the primary active guild is different from the tracked current guild:
          // 1. Move old current guild to previous_guilds
          if (!updatedPrevious.some(p => p.tag === current.tag && p.joined_at === current.joined_at)) {
            updatedPrevious.push({
              tag: current.tag,
              joined_at: current.joined_at,
              left_at: new Date().toISOString()
            });
          }
          // 2. Set new current guild
          updatedCurrent = { tag: primaryGuild.tag, joined_at: primaryGuild.joined_at };

          // 3. Add any other secondary guilds to previous
          for (const sg of otherGuilds) {
            if (sg.tag !== current.tag && !updatedPrevious.some(p => p.tag === sg.tag && p.joined_at === sg.joined_at)) {
              updatedPrevious.push({
                tag: sg.tag,
                joined_at: sg.joined_at,
                left_at: new Date().toISOString()
              });
            }
          }
        } else {
          // If current guild tag matches the primary active guild tag,
          // check if we need to add any other secondary active guilds to previous
          for (const sg of otherGuilds) {
            if (!updatedPrevious.some(p => p.tag === sg.tag && p.joined_at === sg.joined_at)) {
              updatedPrevious.push({
                tag: sg.tag,
                joined_at: sg.joined_at,
                left_at: new Date().toISOString()
              });
            }
          }
        }

        // Only update if changes occurred or username updated
        const needsUpdate = 
          existing.username !== primaryGuild.username ||
          JSON.stringify(existing.current_guild) !== JSON.stringify(updatedCurrent) ||
          JSON.stringify(existing.previous_guilds) !== JSON.stringify(updatedPrevious);

        if (needsUpdate) {
          const { error: updErr } = await supabase
            .from("member_surveillance")
            .update({
              username: primaryGuild.username,
              current_guild: updatedCurrent,
              previous_guilds: updatedPrevious
            })
            .eq("discord_id", discordId);

          if (updErr) {
            console.error(`❌ [Surveillance] Update failed for ${discordId}:`, updErr);
          } else {
            updates++;
          }
        }
      }
    }

    // 5. Handle members who left all approved guilds
    // If a user has a current_guild in the DB, but they were not found in userActiveGuilds:
    // Move their current_guild to previous_guilds and set current_guild to null.
    let leftCount = 0;
    for (const record of existingRecords || []) {
      if (record.current_guild && !userActiveGuilds.has(record.discord_id)) {
        const current = record.current_guild;
        let previous = record.previous_guilds || [];
        if (!Array.isArray(previous)) previous = [];

        const updatedPrevious = [
          ...previous,
          {
            tag: current.tag,
            joined_at: current.joined_at,
            left_at: new Date().toISOString()
          }
        ];

        const { error: leaveErr } = await supabase
          .from("member_surveillance")
          .update({
            current_guild: null,
            previous_guilds: updatedPrevious
          })
          .eq("discord_id", record.discord_id);

        if (leaveErr) {
          console.error(`❌ [Surveillance] Leave update failed for ${record.discord_id}:`, leaveErr);
        } else {
          leftCount++;
        }
      }
    }

    console.log(`✅ [Surveillance] Sync complete: ${inserts} inserts, ${updates} updates, ${leftCount} marked as left.`);
  } catch (err) {
    console.error("❌ [Surveillance] Sync failed with fatal error:", err);
  }
}

module.exports = {
  handleMemberJoin,
  handleMemberLeave,
  syncAllMembers
};
