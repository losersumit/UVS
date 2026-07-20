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
          current_guild: [{ tag: guildTag, joined_at: joinedAt }],
          previous_guilds: []
        });

      if (insertError) {
        console.error(`❌ [Surveillance] Error inserting new member ${discordId}:`, insertError);
      }
    } else {
      // Member exists
      let current = existing.current_guild || [];
      if (!Array.isArray(current)) {
        current = current ? [current] : [];
      }
      let previous = existing.previous_guilds || [];
      if (!Array.isArray(previous)) previous = [];

      // Check if guild already in current
      const alreadyInCurrent = current.some(g => g.tag === guildTag);

      if (!alreadyInCurrent) {
        current.push({ tag: guildTag, joined_at: joinedAt });

        const { error: updateError } = await supabase
          .from("member_surveillance")
          .update({
            username: username,
            current_guild: current,
            previous_guilds: previous
          })
          .eq("discord_id", discordId);

        if (updateError) {
          console.error(`❌ [Surveillance] Error updating member ${discordId}:`, updateError);
        }
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
      let current = existing.current_guild || [];
      if (!Array.isArray(current)) {
        current = current ? [current] : [];
      }
      let previous = existing.previous_guilds || [];
      if (!Array.isArray(previous)) previous = [];

      const guildIndex = current.findIndex(g => g.tag === guildTag);
      if (guildIndex !== -1) {
        // Remove from current_guild
        const [removedGuild] = current.splice(guildIndex, 1);
        
        // Add left_at and archive in previous_guilds
        const archivedGuild = {
          tag: removedGuild.tag,
          joined_at: removedGuild.joined_at,
          left_at: new Date().toISOString()
        };
        const updatedPrevious = [...previous, archivedGuild];

        const { error: updateError } = await supabase
          .from("member_surveillance")
          .update({
            username: username,
            current_guild: current,
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
    const userActiveGuilds = new Map(); // discord_id -> Array of { tag, joined_at, username }

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
      const existing = surveillanceMap.get(discordId);
      const primaryUsername = activeGuildList[0].username;

      if (!existing) {
        // Create new record with all their current active guilds
        const currentList = activeGuildList.map(g => ({ tag: g.tag, joined_at: g.joined_at }));

        const { error: insErr } = await supabase
          .from("member_surveillance")
          .insert({
            discord_id: discordId,
            username: primaryUsername,
            current_guild: currentList,
            previous_guilds: []
          });

        if (insErr) {
          console.error(`❌ [Surveillance] Insert failed for ${discordId}:`, insErr);
        } else {
          inserts++;
        }
      } else {
        // Update existing record
        let current = existing.current_guild || [];
        if (!Array.isArray(current)) {
          current = current ? [current] : [];
        }
        let previous = existing.previous_guilds || [];
        if (!Array.isArray(previous)) previous = [];

        let updatedCurrent = [...current];
        let updatedPrevious = [...previous];

        // 4a. Add new active guilds to current list if they aren't already there
        for (const activeGuild of activeGuildList) {
          const alreadyInCurrent = updatedCurrent.some(cg => cg.tag === activeGuild.tag);
          if (!alreadyInCurrent) {
            updatedCurrent.push({ tag: activeGuild.tag, joined_at: activeGuild.joined_at });
          }
        }

        // 4b. If user is no longer in a guild that we have in current_guild:
        // Move it from current_guild to previous_guilds
        const finalCurrent = [];
        for (const cg of updatedCurrent) {
          const stillInGuild = activeGuildList.some(ag => ag.tag === cg.tag);
          if (stillInGuild) {
            finalCurrent.push(cg);
          } else {
            // Member left this guild (e.g. while bot was offline)
            updatedPrevious.push({
              tag: cg.tag,
              joined_at: cg.joined_at,
              left_at: new Date().toISOString()
            });
          }
        }

        // Only update if changes occurred or username updated
        const needsUpdate = 
          existing.username !== primaryUsername ||
          JSON.stringify(existing.current_guild) !== JSON.stringify(finalCurrent) ||
          JSON.stringify(existing.previous_guilds) !== JSON.stringify(updatedPrevious);

        if (needsUpdate) {
          const { error: updErr } = await supabase
            .from("member_surveillance")
            .update({
              username: primaryUsername,
              current_guild: finalCurrent,
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
    // If a user has items in current_guild in DB, but was not found in userActiveGuilds:
    // Move all current_guild records to previous_guilds and clear current_guild
    let leftCount = 0;
    for (const record of existingRecords || []) {
      let current = record.current_guild || [];
      if (!Array.isArray(current)) {
        current = current ? [current] : [];
      }

      if (current.length > 0 && !userActiveGuilds.has(record.discord_id)) {
        let previous = record.previous_guilds || [];
        if (!Array.isArray(previous)) previous = [];

        const updatedPrevious = [...previous];
        for (const cg of current) {
          updatedPrevious.push({
            tag: cg.tag,
            joined_at: cg.joined_at,
            left_at: new Date().toISOString()
          });
        }

        const { error: leaveErr } = await supabase
          .from("member_surveillance")
          .update({
            current_guild: [],
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
