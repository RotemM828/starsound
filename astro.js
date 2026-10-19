// astro.js — the sky math.
//
// Everything here works in a local "ENU" frame: a 3D unit vector with
//   x = East, y = North, z = Up.
// A star, a planet, or the direction the phone is pointing are all just
// unit vectors in this frame, so "how far apart are they?" is a dot product.

const Astro = (() => {
  const DEG = Math.PI / 180;

  // Julian Date: a continuous day count astronomers use. Unix time 0 = JD 2440587.5.
  function julianDate(date) {
    return date.getTime() / 86400000 + 2440587.5;
  }

  // Local Sidereal Time in degrees: which right ascension is on your meridian now.
  // GMST formula (IAU, accurate to well under a second of time for this century).
  function localSiderealTime(date, lonDeg) {
    const d = julianDate(date) - 2451545.0; // days since the J2000 epoch
    const gmst = 280.46061837 + 360.98564736629 * d;
    return mod360(gmst + lonDeg);
  }

  // Convert a star's catalog position (RA/Dec, degrees) into an ENU unit vector
  // for an observer at latitude latDeg, given the local sidereal time.
  //   Hour angle  HA = LST − RA   (how far west of the meridian the star is)
  //   East  = −cos(Dec)·sin(HA)
  //   North =  sin(Dec)·cos(lat) − cos(Dec)·cos(HA)·sin(lat)
  //   Up    =  sin(Dec)·sin(lat) + cos(Dec)·cos(HA)·cos(lat)   (= sin(altitude))
  function equatorialToENU(raDeg, decDeg, latDeg, lstDeg) {
    const ha = (lstDeg - raDeg) * DEG;
    const dec = decDeg * DEG, lat = latDeg * DEG;
    const cd = Math.cos(dec), sd = Math.sin(dec);
    return [
      -cd * Math.sin(ha),
      sd * Math.cos(lat) - cd * Math.cos(ha) * Math.sin(lat),
      sd * Math.sin(lat) + cd * Math.cos(ha) * Math.cos(lat),
    ];
  }

  // ENU vector -> altitude (degrees above horizon) and azimuth (degrees, N=0, E=90).
  function enuToAltAz(v) {
    return {
      alt: Math.asin(clamp(v[2], -1, 1)) / DEG,
      az: mod360(Math.atan2(v[0], v[1]) / DEG),
    };
  }

  function altAzToENU(altDeg, azDeg) {
    const alt = altDeg * DEG, az = azDeg * DEG;
    return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
  }

  // The reverse trip: ENU vector -> RA/Dec (degrees). Solving the three equations above:
  //   sin(Dec) = North·cos(lat) + Up·sin(lat)
  //   HA = atan2(−East, Up·cos(lat) − North·sin(lat)),  RA = LST − HA
  function enuToEquatorial(v, latDeg, lstDeg) {
    const lat = latDeg * DEG;
    const dec = Math.asin(clamp(v[1] * Math.cos(lat) + v[2] * Math.sin(lat), -1, 1));
    const ha = Math.atan2(-v[0], v[2] * Math.cos(lat) - v[1] * Math.sin(lat));
    return { ra: mod360(lstDeg - ha / DEG), dec: dec / DEG };
  }

  // Which constellation contains a point? Uses the official IAU boundary polygons.
  // Ray casting: walk north from the point along its line of RA and count how many
  // boundary edges we cross. Odd = inside. A polygon that wraps around the north
  // celestial pole (Ursa Minor) flips the answer, because the ray never leaves it.
  const poleCache = new Map();
  function containsNorthPole(ring) {
    if (poleCache.has(ring)) return poleCache.get(ring);
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      sum += ((b[0] - a[0] + 540) % 360) - 180;
    }
    const meanDec = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const res = Math.abs(sum) > 180 && meanDec > 0;
    poleCache.set(ring, res);
    return res;
  }

  function constellationOf(raDeg, decDeg, bounds) {
    for (const [id, ring] of bounds) {
      let crossings = 0;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const la = ((a[0] - raDeg + 540) % 360) - 180; // longitudes relative to the point
        const lb = ((b[0] - raDeg + 540) % 360) - 180;
        if (Math.abs(lb - la) > 180) continue;           // edge on the far side of the sky
        if ((la <= 0) === (lb <= 0)) continue;           // doesn't cross our meridian
        const decAtCross = a[1] + (b[1] - a[1]) * (0 - la) / (lb - la);
        if (decAtCross > decDeg) crossings++;
      }
      if ((crossings % 2 === 1) !== containsNorthPole(ring)) return id;
    }
    return null;
  }

  // Angle between two unit vectors, in degrees (the dot product trick).
  function angleBetween(a, b) {
    return Math.acos(clamp(dot(a, b), -1, 1)) / DEG;
  }

  // A camera frame around the pointing direction f: right, up, forward.
  // Used to place each star's sound left/right and up/down relative to the phone.
  function viewBasis(f) {
    let right = cross(f, [0, 0, 1]);           // horizontal, perpendicular to view
    if (norm(right) < 1e-3) right = [1, 0, 0]; // looking straight up/down: pick East
    right = normalize(right);
    const up = cross(right, f);
    return { right, up, forward: f };
  }

  function toView(basis, v) {
    return [dot(v, basis.right), dot(v, basis.up), dot(v, basis.forward)];
  }

  // Moon and planets via astronomy-engine (J2000 RA/Dec, then our own conversion
  // so the whole sky goes through the same math as the stars).
  const BODIES = ["Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"];
  function solarSystem(date, latDeg, lonDeg) {
    if (typeof Astronomy === "undefined") return [];
    const obs = new Astronomy.Observer(latDeg, lonDeg, 0);
    const lst = localSiderealTime(date, lonDeg);
    return BODIES.map((name) => {
      const eq = Astronomy.Equator(name, date, obs, false, true);
      const vec = equatorialToENU(eq.ra * 15, eq.dec, latDeg, lst);
      const mag = name === "Moon" ? -12 : Astronomy.Illumination(name, date).mag;
      return { name, vec, mag, planet: true };
    });
  }

  function moonPhase(date) {
    if (typeof Astronomy === "undefined") return null;
    const angle = Astronomy.MoonPhase(date); // 0 new, 90 first quarter, 180 full, 270 last
    const lit = Math.round(Astronomy.Illumination("Moon", date).phase_fraction * 100);
    const names = ["new moon", "waxing crescent", "first quarter", "waxing gibbous",
      "full moon", "waning gibbous", "last quarter", "waning crescent"];
    return { name: names[Math.round(angle / 45) % 8], lit };
  }

  function compassWord(azDeg) {
    const w = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
    return w[Math.round(mod360(azDeg) / 45) % 8];
  }

  // small vector helpers
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(a) { return Math.hypot(a[0], a[1], a[2]); }
  function normalize(a) { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function mod360(x) { return ((x % 360) + 360) % 360; }

  return {
    DEG, julianDate, localSiderealTime, equatorialToENU, enuToAltAz, altAzToENU,
    enuToEquatorial, constellationOf,
    angleBetween, viewBasis, toView, solarSystem, moonPhase, compassWord,
    dot, cross, normalize, clamp, mod360,
  };
})();

if (typeof module !== "undefined") module.exports = Astro; // lets Node tests load it
