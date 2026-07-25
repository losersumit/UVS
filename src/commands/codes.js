const { isOwner } = require("../owner");

async function execute(interaction) {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: "❌ Permission denied.", ephemeral: true });
  }

  const codesEmbed = {
    title: "📋 UVS Job Log Rejection Codes",
    description: "Here is the list of three-digit codes associated with each job log rejection reason:",
    color: 0xff7801,
    fields: [
      { name: "102 - Guild/VTC Lock Violation", value: "Driver is registered to a different VTC and logged in the wrong server channel.", inline: false },
      { name: "103 - Unapproved Server", value: "The current Discord server is not approved for career tracking.", inline: false },
      { name: "104 - Duplicate Screenshot", value: "This exact screenshot has already been submitted and processed in the database.", inline: false },
      { name: "105 - Invalid Screenshot", value: "OCR could not recognize this as a valid 'Job Finished' screen (or AI check failed).", inline: false },
      { name: "106 - Suspended Driver", value: "The user is currently suspended from logging runs.", inline: false },
      { name: "203 - Invalid Distance or Time", value: "Extracted distance or time is zero or negative.", inline: false },
      { name: "204 - Invalid Income", value: "Extracted income is negative or not a valid number.", inline: false },
      { name: "205 - Distance Exceeded Limit", value: "Distance exceeds the maximum cap per run (730 km).", inline: false },
      { name: "206 - Speed Limit Exceeded", value: "Average run speed is physically impossible (> 180 km/h).", inline: false },
      { name: "207 - Income Limit Exceeded", value: "Run income exceeds the maximum cap per run (45,000).", inline: false },
      { name: "208 - Income Per KM Exceeded", value: "Income per km exceeds the allowed limit (120/km).", inline: false },
      { name: "209 - Level Regression", value: "The screenshot shows a lower career level than what is stored in the database.", inline: false },
      { name: "301 - System / Database Error", value: "An internal error occurred while saving the run to the database.", inline: false }
    ],
    footer: {
      text: "NMC Bot Owner Tools"
    },
    timestamp: new Date()
  };

  await interaction.reply({ embeds: [codesEmbed], ephemeral: true });
}

module.exports = { execute };
