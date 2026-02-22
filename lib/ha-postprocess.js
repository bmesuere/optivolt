/**
 * ha-postprocess.js
 *
 * Pure functions for normalising raw HA statistics data into flat records.
 * Extracted from fetch-ha-stats.js so it can be used server-side.
 */

/**
 * Get all unique sensor names present in processed data.
 * @param {Array<{sensor: string}>} data
 * @returns {string[]}
 */
export function getSensorNames(data) {
  return [...new Set(data.map(d => d.sensor))];
}

/**
 * Normalise raw HA stats result into flat records.
 *
 * @param {Object} rawData  - HA recorder/statistics_during_period result keyed by entity ID
 * @param {Array<{id: string, name: string, unit: string}>} sensors
 * @param {Array<{name: string, formula: string[]}>} derived
 * @returns {Array<{date: string, time: number, hour: number, dayOfWeek: number, sensor: string, value: number}>}
 */
export function postprocess(rawData, sensors, derived) {
  const nameOf = Object.fromEntries(sensors.map(s => [s.id, s.name]));
  const unitOf = Object.fromEntries(sensors.map(s => [s.id, s.unit]));

  const flat = Object.entries(rawData).flatMap(([id, readings]) => {
    const name = nameOf[id] ?? id;
    const multiplier = unitOf[id] === 'kWh' ? 1000 : 1;
    return readings.map(d => ({
      time: d.start,
      sensor: name,
      value: (d.change ?? 0) * multiplier,
    }));
  });

  // Merge sensors with the same name (e.g. DSMR tariff 1+2)
  const byTimeAndSensor = new Map();
  for (const d of flat) {
    const key = `${d.time}|${d.sensor}`;
    byTimeAndSensor.set(key, (byTimeAndSensor.get(key) ?? 0) + d.value);
  }

  const timestamps = [...new Set(flat.map(d => d.time))].sort((a, b) => a - b);

  const sensorsByTime = new Map();
  for (const [key, value] of byTimeAndSensor) {
    const [timeStr, sensor] = key.split('|');
    const time = Number(timeStr);
    if (!sensorsByTime.has(time)) sensorsByTime.set(time, new Map());
    sensorsByTime.get(time).set(sensor, value);
  }

  // Compute derived series
  if (derived && derived.length > 0) {
    for (const time of timestamps) {
      const sensorsMap = sensorsByTime.get(time);
      for (const { name, formula } of derived) {
        let value = 0;
        for (const term of formula) {
          const sign = term[0] === '-' ? -1 : 1;
          const ref = term.slice(1);
          value += sign * (sensorsMap.get(ref) ?? 0);
        }
        sensorsMap.set(name, value);
      }
    }
  }

  const result = [];
  for (const time of timestamps) {
    const date = new Date(time);
    for (const [sensor, value] of sensorsByTime.get(time)) {
      result.push({
        date: date.toISOString(),
        time,
        hour: date.getUTCHours(),
        dayOfWeek: date.getUTCDay(),
        sensor,
        value,
      });
    }
  }

  return result;
}
