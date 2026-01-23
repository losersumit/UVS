// .uvs/anticheat.js

const LIMITS = {
  MAX_AVG_SPEED: 180,          // km/h (Loose cap to allow for downhill/bugs)
  MAX_DISTANCE_PER_RUN: 5000,  // km
  MAX_INCOME_PER_KM: 5000,     // game currency
};

function reject(reason) {
  return { ok: false, reason };
}

function validateRun(ocr, prevStats) {
  const distance = Number(ocr.distance_km);
  const timeMin = Number(ocr.time_minutes);
  const income = Number(ocr.income);
  const level = Number(ocr.level);
  
  // Safe access to previous stats
  const prevLevel = Number(prevStats?.current_level || 0);
  const prevXP = Number(prevStats?.last_xp || 0);

  if (distance <= 0 || timeMin <= 0) {
    return reject("Invalid distance or time (0 or negative)");
  }

  if (isNaN(income) || income < 0) {
    return reject("Invalid income (must be a non-negative number)");
  }

  if (distance > LIMITS.MAX_DISTANCE_PER_RUN) {
    return reject(`Distance ${distance}km exceeds limit of ${LIMITS.MAX_DISTANCE_PER_RUN}km`);
  }

  // Speed Check
  const avgSpeed = distance / (timeMin / 60);
  if (avgSpeed > LIMITS.MAX_AVG_SPEED) {
    return reject(`Avg Speed ${avgSpeed.toFixed(0)} km/h is physically impossible`);
  }

  // Income Check
  const incomePerKm = income / distance;
  if (incomePerKm > LIMITS.MAX_INCOME_PER_KM) {
    return reject(`Income per km ${incomePerKm.toFixed(0)} exceeds limit of ${LIMITS.MAX_INCOME_PER_KM}`);
  }

  // Progression Check (Anti-Reverse)
  if (level < prevLevel) {
    return reject(`Level regression detected (Previous: ${prevLevel}, Current: ${level})`);
  }

  return { ok: true };
}

module.exports = { validateRun };