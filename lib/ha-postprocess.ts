/**
 * ha-postprocess.ts
 *
 * Pure functions for normalising raw HA statistics data into flat records.
 * Extracted from fetch-ha-stats.js so it can be used server-side.
 */

export interface HaSensor {
  id: string;
  name: string;
  unit: string;
}

export interface HaDerivedSensor {
  name: string;
  formula: string[];
}

export interface StatRecord {
  date: string;
  time: number;
  hour: number;
  dayOfWeek: number;
  sensor: string;
  value: number;
}

interface HaReading {
  start: number;
  change?: number;
}

/**
 * Get all unique sensor names present in processed data.
 */
export function getSensorNames(data: StatRecord[]): string[] {
  return [...new Set(data.map(d => d.sensor))];
}

/**
 * Normalise raw HA stats result into flat records.
 */
export function postprocess(
  rawData: Record<string, HaReading[]>,
  sensors: HaSensor[],
  derived: HaDerivedSensor[],
): StatRecord[] {
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
  const byTimeAndSensor = new Map<string, number>();
  for (const d of flat) {
    const key = `${d.time}|${d.sensor}`;
    byTimeAndSensor.set(key, (byTimeAndSensor.get(key) ?? 0) + d.value);
  }

  const timestamps = [...new Set(flat.map(d => d.time))].sort((a, b) => a - b);

  const sensorsByTime = new Map<number, Map<string, number>>();
  for (const [key, value] of byTimeAndSensor) {
    const [timeStr, sensor] = key.split('|');
    const time = Number(timeStr);
    if (!sensorsByTime.has(time)) sensorsByTime.set(time, new Map());
    sensorsByTime.get(time)!.set(sensor, value);
  }

  // Compute derived series
  if (derived && derived.length > 0) {
    for (const time of timestamps) {
      const sensorsMap = sensorsByTime.get(time)!;
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

  const result: StatRecord[] = [];
  for (const time of timestamps) {
    const date = new Date(time);
    for (const [sensor, value] of sensorsByTime.get(time)!) {
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
