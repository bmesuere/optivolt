/**
 * pv-clear-sky.ts
 *
 * Bird Clear Sky Model — pure solar physics, no PV-specific state.
 */

/**
 * Calculate approximate clear-sky Global Horizontal Irradiance (GHI)
 * using the Bird Clear Sky Model with simplified atmospheric parameters.
 *
 * Reference: Bird, R.E. (1981), "A Simplified Clear Sky Model for Direct
 * and Diffuse Insolation on Horizontal Surfaces", SERI/TR-642-761.
 *
 * The model computes:
 *   1. Solar position (zenith, elevation) from latitude, longitude, date.
 *   2. Extraterrestrial radiation adjusted for earth-sun distance.
 *   3. Atmospheric transmittance: Rayleigh scattering, ozone absorption,
 *      uniform mixed gas absorption, water vapor, aerosol extinction.
 *   4. Direct Normal Irradiance (DNI) and Diffuse Horizontal Irradiance (DHI).
 *   5. GHI = DNI × cos(zenith) + DHI.
 *
 * Uses getUTCHours() + longitude offset for solar time, making it
 * timezone-independent.
 *
 * @param lat  Latitude in degrees
 * @param lon  Longitude in degrees
 * @param date Date object (UTC time used internally)
 * @returns GHI in W/m² (0 if sun is below horizon)
 */
export function calculateClearSkyGHI(lat: number, lon: number, date: Date): number {
  const latRad = lat * Math.PI / 180;

  // Day of year (1-indexed)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  const diff = date.getTime() - yearStart.getTime();
  const dayOfYear = Math.floor(diff / 86400000);

  // Fractional year (gamma) — Spencer (1971)
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (date.getUTCHours() - 12) / 24);

  // Equation of time (minutes) — Spencer (1971)
  const eqTime = 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination angle (radians) — Spencer (1971)
  const declination =
    0.006918
    - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);

  // Solar time: UTC time + equation of time + longitude correction (4 min/degree)
  const timeOffset = eqTime + 4 * lon;
  const solarTime =
    date.getUTCHours()
    + date.getUTCMinutes() / 60
    + date.getUTCSeconds() / 3600
    + timeOffset / 60;

  // Hour angle (radians): 0° at solar noon, 15°/hour
  const hourAngle = (solarTime - 12) * 15 * Math.PI / 180;

  // Solar zenith angle
  const cosZenith =
    Math.sin(latRad) * Math.sin(declination)
    + Math.cos(latRad) * Math.cos(declination) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
  const elevation = Math.PI / 2 - zenith;

  // Sun below horizon → no irradiance
  if (elevation <= 0) return 0;

  // Extraterrestrial radiation adjusted for earth-sun distance variation
  // Solar constant ≈ 1367 W/m²
  const extraterrestrialRadiation = 1367 * (
    1.000110
    + 0.034221 * Math.cos(gamma)
    + 0.001280 * Math.sin(gamma)
    + 0.000719 * Math.cos(2 * gamma)
    + 0.000077 * Math.sin(2 * gamma)
  );

  // Air mass — Kasten & Young (1989) approximation
  const zenithDeg = zenith * 180 / Math.PI;
  const airMass = 1 / (Math.cos(zenith) + 0.50572 * Math.pow(96.07995 - zenithDeg, -1.6364));

  // --- Atmospheric transmittance components ---

  // Rayleigh scattering
  const tRayleigh = Math.exp(
    -0.0903 * Math.pow(airMass, 0.84) * (1.0 + airMass - Math.pow(airMass, 1.01))
  );

  // Ozone absorption (ozone column thickness ≈ 0.3 cm)
  const oz = 0.3;
  const ozAm = oz * airMass;
  const tOzone = 1
    - (0.1611 * ozAm) / Math.pow(1 + 139.48 * ozAm, 0.3035)
    - 0.002715 * ozAm / (1 + 0.044 * ozAm + 0.0003 * ozAm * ozAm);

  // Uniform mixed gas absorption
  const tGases = Math.exp(-0.0127 * Math.pow(airMass, 0.26));

  // Water vapor absorption (precipitable water ≈ 1.5 cm)
  const pw = 1.5;
  const pwAm = pw * airMass;
  const tWater = 1 - (2.4959 * pwAm) / (Math.pow(1 + 79.034 * pwAm, 0.6828) + 6.385 * pwAm);

  // Aerosol extinction (AOD ≈ 0.1 at 500nm for clear conditions)
  const aod = 0.1;
  const tAerosol = Math.exp(
    -Math.pow(aod, 0.873) * (1 + aod - Math.pow(aod, 0.7088)) * Math.pow(airMass, 0.9108)
  );

  // Combined direct-beam transmittance
  const directTransmittance = tRayleigh * tOzone * tGases * tWater * tAerosol;

  // Direct Normal Irradiance
  const dni = extraterrestrialRadiation * directTransmittance;

  // Diffuse Horizontal Irradiance (simplified Bird model)
  const dhi =
    extraterrestrialRadiation * cosZenith * 0.79 * tOzone * tGases * tWater
    * (0.5 * (1 - tRayleigh) + 0.85 * (1 - tAerosol))
    / (1 - airMass + Math.pow(airMass, 1.02));

  // Global Horizontal Irradiance = direct horizontal + diffuse
  const ghi = dni * cosZenith + dhi;

  // 1.10 tuning factor: numerical weather models like ICON scale slightly
  // upward due to 3D cloud-edge effects in standard output
  return Math.max(0, ghi * 1.10);
}
