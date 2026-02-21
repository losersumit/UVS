const fs = require('fs');
const path = require('path');

const rootDir = 'c:\\Users\\yangs\\OneDrive\\Documents\\.TOE3\\.bots\\.uvs';
const srcPath = path.join(rootDir, 'src');

try {
    const stat = fs.statSync(srcPath);
    if (stat.isFile()) {
        console.log('src is a file, deleting it...');
        fs.unlinkSync(srcPath);
        fs.mkdirSync(srcPath);
        console.log('Recreated src as a directory.');
    }
} catch (e) {
    if (e.code === 'ENOENT') {
        fs.mkdirSync(srcPath);
        console.log('Created src directory.');
    }
}

// Now move everything
const scriptsDir = path.join(rootDir, 'scripts');
const srcDir = srcPath;
const dataDir = path.join(rootDir, 'data');

if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const filesToMove = [
    { name: 'list_servers.js', dest: scriptsDir },
    { name: 'leave_server.js', dest: scriptsDir },
    { name: 'spying.js', dest: scriptsDir },
    { name: 'approved_guilds.csv', dest: dataDir },
    { name: 'config.js', dest: srcDir },
    { name: 'owner.js', dest: srcDir },
    { name: 'guildGuard.js', dest: srcDir },
    { name: 'modelRouter.js', dest: srcDir },
    { name: 'anticheat.js', dest: srcDir }
];

filesToMove.forEach(file => {
    const oldPath = path.join(rootDir, file.name);
    const newPath = path.join(file.dest, file.name);

    if (fs.existsSync(oldPath)) {
        try {
            fs.copyFileSync(oldPath, newPath);
            fs.unlinkSync(oldPath);
            console.log(`Copied & Deleted ${file.name}`);
        } catch (e) {
            console.error(`Failed to move ${file.name}: ${e.message}`);
        }
    } else {
        console.log(`Skipped ${file.name} (not found)`);
    }
});

const oldStatsPath = path.join(rootDir, 'stats_system');
const newStatsPath = path.join(srcDir, 'stats_system');
if (fs.existsSync(oldStatsPath) && !fs.existsSync(newStatsPath)) {
    fs.cpSync(oldStatsPath, newStatsPath, { recursive: true });
    fs.rmSync(oldStatsPath, { recursive: true, force: true });
    console.log('Moved stats_system folder');
} else if (fs.existsSync(newStatsPath)) {
    console.log('stats_system already in src/');
    fs.rmSync(oldStatsPath, { recursive: true, force: true });
}

console.log('Done.');
