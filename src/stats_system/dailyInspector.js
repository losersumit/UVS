const cron = require("node-cron");
const { EmbedBuilder } = require("discord.js");
const { supabase } = require("./supabase");
const { analyzeRunsWithReasoning } = require("../modelRouter");

const REPORT_CHANNEL_ID = "1474458715422982156";

/**
 * Sends the suspicious runs report to Discord
 */
async function sendReportToDiscord(client, suspiciousRuns) {
    try {
        const channel = await client.channels.fetch(REPORT_CHANNEL_ID);
        if (!channel) {
            console.error("❌ Daily Inspector: Could not find report channel.");
            return;
        }

        if (!suspiciousRuns || suspiciousRuns.length === 0) {
            // Optional: Send a "All clear" message or just do nothing.
            // For now, we'll send an all clear.
            const embed = new EmbedBuilder()
                .setTitle("✅ Daily Run Inspection: All Clear")
                .setDescription("No highly suspicious runs were detected in the last 24 hours.")
                .setColor(0x00FF00)
                .setTimestamp();
            await channel.send({ embeds: [embed] });
            return;
        }

        // We have suspicious runs. Construct embeds (handling Discord's 25 fields limit)
        const embeds = [];
        let currentEmbed = new EmbedBuilder()
            .setTitle("🚨 Daily Run Inspection: Suspicious Activity Detected")
            .setDescription(`Found **${suspiciousRuns.length}** suspicious runs in the last 24 hours that require manual review.`)
            .setColor(0xFF0000)
            .setTimestamp();

        for (let i = 0; i < suspiciousRuns.length; i++) {
            const run = suspiciousRuns[i];

            // Ensure name is within limits, fallback safely
            let nameField = `Run ID: ${run.run_id || 'Unknown'}`;
            if (run.username) {
                nameField = `${run.username} ${run.guild_tag ? `[${run.guild_tag}]` : ''}`;
            }

            const valueField =
                `**Reason:** ${run.reason || 'Flagged by AI'}\n` +
                `**Stats:** ${run.distance_km || 0}km in ${run.time_minutes || 0}m\n` +
                `**Score/Income:** ${run.score || 0} pts, $${run.income || 0}\n` +
                `**Penalties:** Dmg: $${run.damage_penalty || 0}, Time: $${run.time_penalty || 0}`;

            currentEmbed.addFields({
                name: nameField,
                value: valueField,
                inline: false
            });

            // 25 fields max per embed
            if (currentEmbed.data.fields.length >= 25 || i === suspiciousRuns.length - 1) {
                embeds.push(currentEmbed);
                if (i < suspiciousRuns.length - 1) {
                    currentEmbed = new EmbedBuilder().setColor(0xFF0000); // Continuation embed
                }
            }
        }

        for (const embed of embeds) {
            await channel.send({ embeds: [embed] });
        }

    } catch (err) {
        console.error("❌ Daily Inspector: Failed to send Discord report:", err);
    }
}

/**
 * Main routine to fetch runs, analyze them, and dispatch
 */
async function runDailyInspection(client) {
    console.log("🔍 [Daily Inspector] Starting inspection routine...");
    try {
        // 1. Fetch runs from the last 24 hours
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateString = yesterday.toISOString();

        const { data: runs, error } = await supabase
            .from("runs")
            .select(`
        id, created_at, score, income, distance, time_taken,
        players (
          username, discord_id, guild_tag
        )
      `)
            .gte("created_at", dateString);

        if (error) {
            console.error("❌ Daily Inspector: Failed to fetch runs:", error);
            return;
        }

        if (!runs || runs.length === 0) {
            console.log("🔍 [Daily Inspector] No runs found in the last 24 hours.");
            await sendReportToDiscord(client, []);
            return;
        }

        console.log(`🔍 [Daily Inspector] Fetched ${runs.length} runs. Preparing payload...`);

        // 2. Format data compactly for the LLM
        const formattedRuns = runs.map(r => ({
            run_id: r.id,
            username: r.players?.username || "Unknown",
            guild_tag: r.players?.guild_tag || "",
            distance_km: r.distance,
            time_minutes: r.time_taken,
            score: r.score,
            income: r.income
        }));

        // If there are too many runs (e.g. > 100), we might hit token limits.
        // A robust system would chunk them. For V1, we pass them directly.
        const chunks = [];
        const chunkSize = 50; // Max 50 runs per prompt to keep JSON stable
        for (let i = 0; i < formattedRuns.length; i += chunkSize) {
            chunks.push(formattedRuns.slice(i, i + chunkSize));
        }

        let allSuspiciousRuns = [];

        for (const chunk of chunks) {
            const prompt = `
You are a highly analytical game economy anti-cheat system for the driving game "Truckers of Europe 3".
Your task is to analyze the following batch of recent player delivery runs and flag ANY run that is highly suspicious or physically impossible.

### Detection Rules:
1. **Impossible Speeds:** If distance > 0 and time_minutes > 0, calculate speed (Distance / (Time/60)). Any average speed > 150 km/h is extremely suspicious.
2. **Instant Deliveries:** If distance > 10 but time is 0 or 1 minute.
3. **Mismatched Economics:** Extremely high income (e.g., >$10,000) for very short distances (e.g., < 100km).
4. **Mismatched Scoring:** Exceptionally high score for a short/fast run.

### Input Data:
${JSON.stringify(chunk, null, 2)}

### Output Format:
Return ONLY a valid JSON object matching exactly this schema:
{
  "suspicious_runs": [
    {
      "run_id": number,
      "username": "string",
      "guild_tag": "string",
      "distance_km": number,
      "time_minutes": number,
      "score": number,
      "income": number,
      "reason": "Clear explanation of why this was flagged (e.g., Avg speed was 180 km/h, which is impossible)"
    }
  ]
}
If NO runs are suspicious, return {"suspicious_runs": []}. Do not output any markdown text.
`;

            console.log(`🔍 [Daily Inspector] Requesting AI Analysis for chunk of ${chunk.length} runs...`);
            const result = await analyzeRunsWithReasoning(prompt);

            if (result && result.suspicious_runs && Array.isArray(result.suspicious_runs)) {
                allSuspiciousRuns = allSuspiciousRuns.concat(result.suspicious_runs);
            } else {
                console.error("❌ Daily Inspector: Warning, AI returned invalid format or null.");
            }
        }

        console.log(`🔍 [Daily Inspector] AI identified ${allSuspiciousRuns.length} suspicious runs.`);

        // 3. Send out the report
        await sendReportToDiscord(client, allSuspiciousRuns);


    } catch (err) {
        console.error("❌ Daily Inspector Error:", err);
    }
}

/**
 * Registers the daily cron job
 */
function registerDailyInspector(client) {
    // Run everyday at 00:00 (Midnight server time)
    cron.schedule("0 0 * * *", () => {
        runDailyInspection(client);
    });

    console.log("✅ Daily Inspector Cron scheduled for midnight.");
}

module.exports = { registerDailyInspector, runDailyInspection };
