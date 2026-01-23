# UVS Bot Setup Guide

## 🚀 Quick Start

### 1. Invite the Bot to Your Server

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your bot application
3. Go to **OAuth2** → **URL Generator**
4. Select these scopes:
   - `bot`
   - `applications.commands`
5. Select these bot permissions:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Attach Files
   - ✅ Read Message History
   - ✅ Add Reactions
6. Copy the generated URL and open it in your browser
7. Select the server and authorize

### 2. Database Setup (Supabase)

The bot requires a Supabase database with these tables:

#### Required Tables:

**`approved_guilds`**
```sql
CREATE TABLE approved_guilds (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT UNIQUE NOT NULL,
  guild_tag TEXT NOT NULL,
  avatar_url TEXT,
  embed_color INTEGER DEFAULT 0xff7801,
  screenshot_channel_id TEXT,
  leaderboard_channel_id TEXT,
  star_1_emoji TEXT DEFAULT '⭐',
  star_2_emoji TEXT DEFAULT '⭐',
  star_3_emoji TEXT DEFAULT '⭐',
  enable_clear_stats BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**`players`**
```sql
CREATE TABLE players (
  id BIGSERIAL PRIMARY KEY,
  discord_id TEXT NOT NULL,
  username TEXT NOT NULL,
  guild_id TEXT NOT NULL REFERENCES approved_guilds(guild_id),
  guild_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**`player_stats`**
```sql
CREATE TABLE player_stats (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id),
  total_distance_km NUMERIC DEFAULT 0,
  total_time_minutes INTEGER DEFAULT 0,
  best_avg_speed_kmph NUMERIC DEFAULT 0,
  clean_deliveries INTEGER DEFAULT 0,
  current_level INTEGER DEFAULT 0,
  last_level INTEGER DEFAULT 0,
  last_xp INTEGER DEFAULT 0,
  total_damage_penalty NUMERIC DEFAULT 0,
  total_time_penalty NUMERIC DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  total_stars INTEGER DEFAULT 0,
  total_income NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**`runs`**
```sql
CREATE TABLE runs (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES players(id),
  image_hash TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL,
  stars INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**`run_rejections`**
```sql
CREATE TABLE run_rejections (
  id BIGSERIAL PRIMARY KEY,
  player_id BIGINT REFERENCES players(id),
  guild_id TEXT,
  reason TEXT NOT NULL,
  image_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3. Add Your Server to the Database

After inviting the bot, you need to add your server to the `approved_guilds` table with **all server-specific settings**:

```sql
INSERT INTO approved_guilds (
  guild_id, 
  guild_tag, 
  avatar_url, 
  embed_color,
  screenshot_channel_id,
  leaderboard_channel_id,
  star_1_emoji,
  star_2_emoji,
  star_3_emoji,
  enable_clear_stats
)
VALUES (
  'YOUR_SERVER_ID',                    -- Get from Discord: Right-click server → Copy Server ID
  '[YOUR_TAG]',                        -- e.g., '[NMC]' - shown in stats
  'https://example.com/logo.png',      -- Optional: Server logo URL for embeds
  0xff7801,                            -- Optional: Embed color (hex as integer)
  'SCREENSHOT_CHANNEL_ID',             -- Channel ID for screenshot submissions
  'LEADERBOARD_CHANNEL_ID',            -- Channel ID for leaderboard messages
  '<:stara:emoji_id>',                 -- Custom emoji for 1 star
  '<:starb:emoji_id>',                 -- Custom emoji for 2 stars
  '<:starc:emoji_id>',                 -- Custom emoji for 3 stars
  true                                 -- Enable /clearstats command
);
```

### 4. Configure Environment Variables

Create a `.env` file with **only global settings** (server-specific settings are now in the database):

```env
# Discord
DISCORD_TOKEN=your_bot_token_here
BOT_OWNER_ID=your_discord_user_id

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_key
```

**Note**: All server-specific settings (channels, emojis, branding) are now stored in the `approved_guilds` table in the database. This allows the bot to support multiple servers with different configurations!

**Career System Only**: This bot is focused solely on the career/stats system. It does not handle auto-roles, join/leave logs, or any other server management features.

### 5. Get Channel/Role IDs

1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click on channels/roles → Copy ID

### 6. Run the Bot

```bash
npm install
node index.js
```

## 🔧 Multi-Server Configuration

### Adding a New Server

1. Invite the bot to the new server
2. Add the server configuration to the database:

```sql
INSERT INTO approved_guilds (
  guild_id, guild_tag, screenshot_channel_id, 
  leaderboard_channel_id
) VALUES (
  'NEW_SERVER_ID', '[TAG]', 'CHANNEL_ID', 
  'CHANNEL_ID'
);
```

### Updating Server Settings

Update any server's configuration:

```sql
UPDATE approved_guilds
SET 
  avatar_url = 'https://your-server.com/logo.png',
  embed_color = 0x00ff00,  -- Green color
  guild_tag = '[NEWTAG]',
  screenshot_channel_id = 'NEW_CHANNEL_ID',
  star_1_emoji = '<:newstar:emoji_id>'
WHERE guild_id = 'YOUR_SERVER_ID';
```

The bot will automatically use these settings for that server. Changes are cached for 5 minutes for performance.

## 📋 Features

- ✅ Screenshot processing (OCR from game screenshots)
- ✅ Player stats tracking
- ✅ Leaderboards (speed, level, distance, time, score)
- ✅ Anticheat validation
- ✅ Server-specific branding
- ✅ Slash commands

## 🛠️ Commands

- `/stats [user]` - View player stats
- `/speedlb` - Top speed leaderboard
- `/levellb` - Top level leaderboard
- `/clearstats [user]` - Clear player stats (Owner only)

## ⚠️ Important Notes

1. **Profile Pictures**: Discord bots have ONE global profile picture. You cannot have different profile pictures per server. However, the bot uses server-specific avatars in embeds.

2. **Multi-Server Setup**: The bot fully supports multiple servers with different configurations. Each server's settings (channels, roles, emojis, branding) are stored in the `approved_guilds` table.

3. **Configuration**: All server-specific settings are stored in the database, not in `.env`. This allows each server to have completely different channel IDs, emojis, and branding.

4. **Permissions**: Ensure the bot has proper permissions in all channels it needs to access.

## 🐛 Troubleshooting

- **Bot not responding**: Check if server is in `approved_guilds` table
- **Screenshots not processing**: Verify `screenshot_channel_id` is set correctly in the database
- **Commands not working**: Ensure bot has `applications.commands` scope
- **Database errors**: Check Supabase connection and table structure
