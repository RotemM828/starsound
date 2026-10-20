// app.js — ties it together: builds tonight's sky, listens to where the phone
// points, plays the stars in view, and speaks names when you lock onto one.

(() => {
  const DEFAULT_LOC = { lat: 34.1459, lon: -118.8059, label: "Westlake Village" };
  // The listening circle: stars within FOCUS[x].half degrees of where you aim are audible.
  // "normal" is 22 degrees across, about two fists held at arm's length.
  const FOCUS = {
    narrow: { half: 8, voices: 3 },
    normal: { half: 11, voices: 5 },
    wide: { half: 15, voices: 6 },
  };
  let FOV_HALF = FOCUS.normal.half;
  let MAX_VOICES = FOCUS.normal.voices;
  let STAR_LIMIT = 3.5;      // faintest star that plays (3.5 is roughly what you see from a suburb)
  const LOCK_ANGLE = 3;      // degrees: hold this close to a bright object to hear its name
  const LOCK_HOLD_MS = 700;  // ...for this long, while holding still
  const LOCK_MAG = 2.3;      // stars must be at least this bright to be announced automatically

  function setFocus(name) {
    const f = FOCUS[name] || FOCUS.normal;
    FOV_HALF = f.half; MAX_VOICES = f.voices;
    return name in FOCUS ? name : "normal";
  }
  function setDetail(name) {
    STAR_LIMIT = { fewest: 2.5, bright: 3.5, more: 4.5 }[name] || 3.5;
    return STAR_LIMIT;
  }

  const el = (id) => document.getElementById(id);
  const S = window.SKY_DATA;

  const app = {
    loc: { ...DEFAULT_LOC },
    timeMode: "now",        // "now" | "tonight" (9 PM local, handy for daytime demos)
    objects: [],            // stars + planets with ENU vectors for the current time
    running: false,
    paused: false,
    mode: "explore",        // "explore" | "find"
    target: null,
    nextPing: new Map(),
    lock: { id: null, since: 0 },
    announced: new Map(),   // id -> time last announced
    lastCon: null, conSince: 0,
    belowWarned: false,
    lastVec: [0, 1, 0], speed: 0, lastFrame: performance.now(),
    nextHint: 0, nextTick: 0,
    playingMelody: false, melodyToken: 0,
    listening: false,
    tour: null,             // { stops: [target...], i }
    lastTopic: null,        // { kind: "obj", id } | { kind: "con", id } for "tell me more"
    storyHintGiven: false,
    hintsGiven: 0,          // the first few announcements teach follow-up questions
    followHints: 0,
    nearList: [],
  };

  // ---------- saved settings (this phone only) ----------
  const Prefs = {
    load() { try { return JSON.parse(localStorage.getItem("starsound-prefs") || "{}"); } catch (_) { return {}; } },
    save(p) { try { localStorage.setItem("starsound-prefs", JSON.stringify({ ...Prefs.load(), ...p })); } catch (_) {} },
  };

  // ---------- sky ----------
  function skyDate() {
    const d = new Date();
    if (app.timeMode === "tonight") {
      d.setHours(21, 0, 0, 0);
    }
    return d;
  }

  function rebuildSky() {
    const date = skyDate();
    const lst = Astro.localSiderealTime(date, app.loc.lon);
    const stars = S.stars.map((s, i) => ({
      id: "s" + i, idx: i, kind: "star", star: s, mag: s.mag,
      vec: Astro.equatorialToENU(s.ra, s.dec, app.loc.lat, lst),
      freq: Sound.pitchFromColor(s.bv),
    }));
    const bodies = Astro.solarSystem(date, app.loc.lat, app.loc.lon).map((b) => ({
      id: "p" + b.name, kind: b.name === "Moon" ? "moon" : "planet", name: b.name,
      mag: b.mag, vec: b.vec,
      freq: b.name === "Moon" ? 196 : { Mercury: 1047, Venus: 880, Mars: 330, Jupiter: 262, Saturn: 220 }[b.name],
    }));
    app.objects = stars.concat(bodies);
    app.byId = new Map(app.objects.map((o) => [o.id, o]));
    app.date = date;
    app.lst = lst;
  }

  // ---------- describing things in words ----------
  const COLOR_WORDS = { O: "blue", B: "blue-white", A: "white", F: "yellow-white",
    G: "yellow, like our Sun", K: "orange", M: "red" };
  const PLANET_FACTS = {
    Mercury: "the closest planet to the Sun",
    Venus: "the brightest planet, covered in thick clouds",
    Mars: "the red planet",
    Jupiter: "the largest planet",
    Saturn: "the ringed planet",
  };

  function nameOf(o) {
    if (o.kind !== "star") return o.name;
    return o.star.name || o.star.bayer || null;
  }

  function whereWords(o) {
    const { alt, az } = Astro.enuToAltAz(o.vec);
    if (alt < 0) return "below the horizon, toward the " + Astro.compassWord(az);
    const height = alt > 70 ? "nearly overhead" : alt > 40 ? "high" : alt > 15 ? "partway up" : "low";
    return `${height} in the ${Astro.compassWord(az)}, ${Math.round(alt)} degrees up`;
  }

  function describe(o, { withPlace = false } = {}) {
    const parts = [];
    if (o.kind === "moon") {
      const ph = Astro.moonPhase(app.date);
      if (!ph) parts.push("The Moon");
      else {
        const phase = /moon/.test(ph.name) ? `a ${ph.name}` : /quarter/.test(ph.name) ? `at ${ph.name}` : ph.name;
        parts.push(`The Moon, ${phase}, ${ph.lit} percent lit`);
      }
    } else if (o.kind === "planet") {
      parts.push(`${o.name}, ${PLANET_FACTS[o.name] || "a planet"}`);
    } else {
      const s = o.star;
      const name = nameOf(o);
      const con = s.con && S.cons[s.con];
      parts.push(name ? `${name}${con && s.name ? ", in " + con : ""}` : `A star in ${con || "the sky"}`);
      const color = COLOR_WORDS[s.sp];
      const bright = s.mag < 0.5 ? "One of the brightest stars in the sky" : s.mag < 1.6 ? "A very bright star" : "";
      if (bright && color) parts.push(`${bright}, ${color}`);
      else if (color) parts.push(`A ${color.split(",")[0]} star`);
      if (s.ly) parts.push(`About ${s.ly.toLocaleString()} light-years away`);
    }
    if (withPlace) parts.push(capitalize(whereWords(o)));
    return parts.join(". ") + ".";
  }

  function capitalize(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

  // ---------- constellation names people understand ----------
  // Latin names alone ("Canes Venatici") mean little when heard, so we add the meaning.
  const CON_EN = {
    And: "the chained princess", Ant: "the air pump", Aps: "the bird of paradise", Aqr: "the water bearer",
    Aql: "the eagle", Ara: "the altar", Ari: "the ram", Aur: "the charioteer", Boo: "the herdsman",
    Cae: "the chisel", Cam: "the giraffe", Cnc: "the crab", CVn: "the hunting dogs", CMa: "the great dog",
    CMi: "the little dog", Cap: "the sea goat", Car: "the keel of a ship", Cas: "the queen", Cen: "the centaur",
    Cep: "the king", Cet: "the sea monster", Cha: "the chameleon", Cir: "the drawing compass", Col: "the dove",
    Com: "Berenice's hair", CrA: "the southern crown", CrB: "the northern crown", Crv: "the crow", Crt: "the cup",
    Cru: "the southern cross", Cyg: "the swan", Del: "the dolphin", Dor: "the swordfish", Dra: "the dragon",
    Equ: "the little horse", Eri: "the river", For: "the furnace", Gem: "the twins", Gru: "the crane",
    Her: "the hero", Hor: "the clock", Hya: "the water snake", Hyi: "the little water snake", Ind: "the Indian",
    Lac: "the lizard", Leo: "the lion", LMi: "the little lion", Lep: "the hare", Lib: "the scales", Lup: "the wolf",
    Lyn: "", Lyr: "the lyre", Men: "the table mountain", Mic: "the microscope", Mon: "the unicorn", Mus: "the fly",
    Nor: "the carpenter's square", Oct: "the octant", Oph: "the serpent bearer", Ori: "the hunter", Pav: "the peacock",
    Peg: "the winged horse", Per: "the hero", Phe: "", Pic: "the painter's easel", Psc: "the fishes",
    PsA: "the southern fish", Pup: "the stern of a ship", Pyx: "the ship's compass", Ret: "the net", Sge: "the arrow",
    Sgr: "the archer", Sco: "the scorpion", Scl: "the sculptor", Sct: "the shield", Ser: "the serpent",
    Sex: "the sextant", Tau: "the bull", Tel: "the telescope", Tri: "the triangle", TrA: "the southern triangle",
    Tuc: "the toucan", UMa: "the great bear, home of the Big Dipper", UMi: "the little bear, home of the North Star",
    Vel: "the sails", Vir: "the maiden", Vol: "the flying fish", Vul: "the little fox",
  };
  function conSpoken(id) {
    const name = S.cons[id] || id;
    return CON_EN[id] ? `${name}, ${CON_EN[id]}` : name;
  }

  // Where is something compared with where the phone points? ("up and to your left")
  function relativeWords(f, vec) {
    const p = Astro.enuToAltAz(f), t = Astro.enuToAltAz(vec);
    const dAz = ((t.az - p.az + 540) % 360) - 180;
    const dAlt = t.alt - p.alt;
    const parts = [];
    if (dAlt > 4) parts.push(dAlt > 20 ? "well above where you're pointing" : "a little higher");
    else if (dAlt < -4) parts.push(dAlt < -20 ? "well below where you're pointing" : "a little lower");
    if (Math.abs(dAz) > 4 && t.alt < 80) parts.push(Math.abs(dAz) > 20 ? `to your ${dAz > 0 ? "right" : "left"}` : `slightly to your ${dAz > 0 ? "right" : "left"}`);
    return parts.length ? parts.join(" and ") : "right where you're pointing";
  }


  // ---------- smart follow-ups: describe it, what's nearby, the brightest thing ----------
  function spokenName(o) {
    if (o.kind === "moon") return "the Moon";
    return nameOf(o) || "a star";
  }

  function colorWord(o) {
    return (COLOR_WORDS[o.star.sp] || "").split(",")[0];
  }

  function shortType(o) {
    if (o.kind === "moon") { const ph = Astro.moonPhase(app.date); return ph ? ph.name : "our Moon"; }
    if (o.kind === "planet") return "a planet";
    const c = colorWord(o);
    const con = o.star.con ? ` in ${S.cons[o.star.con]}` : "";
    return `${c ? (/^[aeiou]/.test(c) ? "an " : "a ") + c + " star" : "a star"}${con}`;
  }

  // brightness rank among all stars in the catalog
  const RANK = new Map(S.stars.map((s, i) => [i, s]).sort((a, b) => a[1].mag - b[1].mag).map(([i], r) => [i, r + 1]));
  function brightnessWords(o) {
    const r = RANK.get(o.idx);
    if (r <= 5) return "one of the five brightest stars in the night sky";
    if (r <= 10) return "one of the ten brightest stars in the night sky";
    if (r <= 25) return "one of the 25 brightest stars in the night sky";
    if (r <= 60) return "one of the brighter stars in the sky";
    return "";
  }

  // typical surface temperatures by spectral class, in kelvin
  const TEMP_K = { O: 40000, B: 20000, A: 8500, F: 6700, G: 5600, K: 4500, M: 3300 };
  function temperatureWords(o) {
    const k = TEMP_K[o.star.sp];
    if (!k) return "";
    const f = Math.round((k * 1.8 - 459.67) / 1000) * 1000;
    const vsSun = k > 6200 ? "hotter than our Sun" : k < 5200 ? "cooler than our Sun" : "about as hot as our Sun";
    return `Its surface is roughly ${f.toLocaleString()} degrees Fahrenheit, ${vsSun}.`;
  }

  function describeTarget(target) {
    if (!target) return;
    const parts = [];
    if (target.type === "object") {
      const o = app.byId.get(target.id);
      if (!o) return;
      app.lastTopic = { kind: "obj", id: o.id, at: performance.now() };
      if (o.kind === "star") {
        const s = o.star;
        parts.push(`${capitalize(spokenName(o))} is ${shortType(o).replace(/ in .*/, "")}${s.con ? ` in ${conSpoken(s.con)}` : ""}.`);
        const b = brightnessWords(o);
        if (b) parts.push(`It's ${b}.`);
        const t = temperatureWords(o);
        if (t) parts.push(t);
        if (s.ly) parts.push(`It's about ${s.ly.toLocaleString()} light-years away, so the light reaching you tonight left it about ${s.ly.toLocaleString()} years ago.`);
      } else if (o.kind === "moon") {
        const ph = Astro.moonPhase(app.date);
        parts.push(`The Moon is ${phaseWords(ph)}, ${ph.lit} percent lit.`);
        parts.push(distanceSentence(target));
      } else {
        parts.push(`${o.name} is ${PLANET_FACTS[o.name] || "a planet"}.`);
        parts.push(distanceSentence(target));
      }
      parts.push(`Right now it's ${whereWords(o)}.`);
      const story = storyForObject(o);
      if (story) parts.push(story);
    } else if (target.type === "con") {
      app.lastTopic = { kind: "con", id: target.id, at: performance.now() };
      parts.push(`${conSpoken(target.id)}. It's ${whereWords({ vec: targetVec(target) })}.`);
      const brightest = [...new Set(S.lines[target.id].flat())].map((i) => app.objects[i])
        .filter((o) => o.star.name).sort((a, b) => a.mag - b.mag)[0];
      if (brightest) parts.push(`Its brightest star is ${brightest.star.name}.`);
      if (STORIES.cons[target.id]) parts.push(STORIES.cons[target.id]);
    } else if (target.type === "sun") {
      parts.push("The Sun is our star, about 93 million miles away. StarSound doesn't guide you to it, so nobody nearby looks straight at it.");
    } else {
      return findTarget(target);
    }
    if (app.followHints < 2) {
      parts.push("You can also ask: how far is it, when does it set, or what's nearby.");
      app.followHints++;
    }
    Voice.say(parts.join(" "));
  }

  function phaseWords(ph) {
    return /moon/.test(ph.name) ? `a ${ph.name}` : /quarter/.test(ph.name) ? `at ${ph.name}` : `a ${ph.name} moon`;
  }

  // describe where b is, as seen by someone looking at a ("above and to the left")
  function relativeTo(a, b) {
    const pa = Astro.enuToAltAz(a), pb = Astro.enuToAltAz(b);
    const dAz = ((pb.az - pa.az + 540) % 360) - 180, dAlt = pb.alt - pa.alt;
    const parts = [];
    if (dAlt > 3) parts.push("above"); else if (dAlt < -3) parts.push("below");
    if (Math.abs(dAz) > 3) parts.push(`to the ${dAz > 0 ? "right" : "left"}`);
    return parts.length ? parts.join(" and ") : "right next to it";
  }

  function topicVec() {
    const t = app.lastTopic;
    const recent = t && performance.now() - (t.at || 0) < 120000;
    if (!recent) return null;
    if (t.kind === "obj") { const o = app.byId.get(t.id); return o ? { vec: o.vec, name: spokenName(o), id: o.id } : null; }
    return { vec: targetVec({ type: "con", id: t.id }), name: S.cons[t.id], id: null };
  }

  function nearby() {
    const topic = topicVec();
    const center = topic ? topic.vec : Sensors.state.vec;
    const label = topic ? topic.name : "where you're pointing";
    const near = app.objects
      .filter((o) => o.id !== (topic && topic.id) && (o.kind !== "star" || (o.star.name && o.mag < 2.6)))
      .filter((o) => o.vec[2] > 0 || el("below").checked)
      .map((o) => ({ o, a: Astro.angleBetween(center, o.vec) }))
      .filter((x) => x.a < 30)
      .sort((x, y) => x.a - y.a)
      .slice(0, 3);
    if (!near.length) {
      Voice.say(`Nothing bright is near ${label}. Say what's up tonight to hear where the bright objects are.`);
      return;
    }
    const items = near.map((x) => `${spokenName(x.o)}, ${relativeTo(center, x.o.vec)}`);
    app.nearList = near.map((x) => x.o.id);
    const spoken = items.length === 1 ? items[0] : items.slice(0, -1).join("; ") + "; and " + items[items.length - 1];
    Voice.say(`Near ${label}: ${spoken}. Say find, and a name, to go there.`);
  }

  function brightest() {
    const up = app.objects.filter((o) => o.vec[2] > 0.09);
    if (!up.length) { Voice.say("Nothing bright is above the horizon right now."); return; }
    const top = up.slice().sort((a, b) => a.mag - b.mag)[0];
    const star = up.filter((o) => o.kind === "star" && o.star.name).sort((a, b) => a.mag - b.mag)[0];
    let t = `The brightest thing in the sky right now is ${spokenName(top)}, ${whereWords(top)}.`;
    if (star && star !== top) t += ` The brightest star is ${star.star.name}, ${whereWords(star)}.`;
    t += ` Say find ${spokenName(top).replace(/^the /, "the ")} to go there.`;
    app.lastTopic = { kind: "obj", id: top.id, at: performance.now() };
    Voice.say(t);
  }

  // the context card: what "it" means right now, with quick buttons
  let shownTopicKey = null;
  function updateTopicCard() {
    const card = el("topicCard");
    if (!card) return;
    const t = app.running ? topicVec() : null;
    const key = t ? (app.lastTopic.kind + app.lastTopic.id) : null;
    if (key === shownTopicKey) return;
    shownTopicKey = key;
    card.hidden = !t;
    if (t) el("topicName").textContent = capitalize(t.name);
  }

  // ---------- stories ("tell me more") ----------
  const STORIES = window.STORIES || { stars: {}, planets: {}, cons: {} };

  function storyForObject(o) {
    if (o.kind !== "star") return STORIES.planets[o.name] || null;
    return (o.star.name && STORIES.stars[o.star.name]) || null;
  }

  function hasStory(o) {
    return !!(storyForObject(o) || (o.kind === "star" && o.star.con && STORIES.cons[o.star.con]));
  }

  function tellMore(topic) {
    topic = topic || app.lastTopic;
    if (!topic) {
      const con = constellationAt(Sensors.state.vec);
      topic = con ? { kind: "con", id: con } : null;
    }
    if (!topic) { Voice.say("Point at something first, then say tell me more."); return; }
    if (topic.kind === "con") {
      const s = STORIES.cons[topic.id];
      Voice.say(s || `${conSpoken(topic.id)}. I don't have a story for this constellation yet.`);
      return;
    }
    const o = app.byId.get(topic.id);
    if (!o) return;
    const s = storyForObject(o);
    if (s) { Voice.say(s); return; }
    const con = o.kind === "star" && o.star.con;
    if (con && STORIES.cons[con]) Voice.say(`${nameOf(o)} is part of ${S.cons[con]}. ${STORIES.cons[con]}`);
    else Voice.say(`I don't have a story for ${nameOf(o) || "this star"} yet. ${describe(o)}`);
  }

  // ---------- turning spoken names into targets ----------
  const DIRECTIONS = {
    north: { alt: 20, az: 0, label: "north" }, east: { alt: 20, az: 90, label: "east" },
    south: { alt: 20, az: 180, label: "south" }, west: { alt: 20, az: 270, label: "west" },
    up: { alt: 90, az: 0, label: "straight up" },
  };

  function buildVocabulary() {
    const v = [];
    for (const n of ["Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]) v.push({ key: n, ref: "planet:" + n });
    for (const s of S.stars) if (s.name) v.push({ key: s.name, ref: "star:" + s.name });
    for (const [id, name] of Object.entries(S.cons)) if (S.lines[id]) v.push({ key: name, ref: "con:" + id });
    Commands.setVocabulary(v);
  }

  function resolveRef(ref) {
    if (ref === "topic") { // "it", "that": whatever we were just talking about
      const t = app.lastTopic;
      if (!t) return null;
      if (t.kind === "obj") { const o = app.byId.get(t.id); return o ? { type: "object", id: o.id, label: spokenName(o) } : null; }
      return { type: "con", id: t.id, label: S.cons[t.id] };
    }
    const [kind, name] = ref.split(":");
    if (kind === "planet" && name === "Sun") return { type: "sun", id: "Sun", label: "the Sun" };
    if (kind === "planet") return { type: "object", id: "p" + name, label: name === "Moon" ? "the Moon" : name };
    if (kind === "star") {
      const i = S.stars.findIndex((s) => s.name === name);
      return i >= 0 ? { type: "object", id: "s" + i, label: name } : null;
    }
    if (kind === "con") return S.lines[name] ? { type: "con", id: name, label: S.cons[name] } : null;
    if (kind === "dir") return DIRECTIONS[name] ? { type: "dir", id: name, label: DIRECTIONS[name].label } : null;
    return null;
  }

  // The official constellation that contains the direction you're aiming.
  function constellationAt(vec) {
    const eq = Astro.enuToEquatorial(vec, app.loc.lat, app.lst);
    return Astro.constellationOf(eq.ra, eq.dec, S.bounds);
  }

  // ---------- main loop ----------
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.max(1, now - app.lastFrame) / 1000;
    app.lastFrame = now;
    idleDrift();
    const f = Sensors.update();
    app.speed = app.speed * 0.8 + 0.2 * (Astro.angleBetween(f, app.lastVec) / dt);
    app.lastVec = f;
    draw(f);
    updateStatus(f);
    const talking = Voice.speaking();
    if (talking !== app.ducked) { app.ducked = talking; Sound.duck(talking); }
    if (!app.running || app.paused || app.listening) return;

    if (app.mode === "find") findStep(f, now);
    else if (!app.playingMelody) exploreStep(f, now);
  }

  function exploreStep(f, now) {
    const basis = Astro.viewBasis(f);
    const aimAlt = Astro.enuToAltAz(f).alt;
    const showBelow = el("below").checked;

    if (aimAlt < -5 && !showBelow) {
      if (!app.belowWarned && Voice.say("Below the horizon. Aim higher.", { auto: true })) app.belowWarned = true;
      return;
    }
    if (aimAlt > 0) app.belowWarned = false;

    // which objects are in the listening cone?
    const inView = [];
    for (const o of app.objects) {
      if (!showBelow && o.vec[2] < 0) continue;
      if (o.kind === "star" && o.mag > STAR_LIMIT) continue;
      const a = Astro.angleBetween(f, o.vec);
      if (a > FOV_HALF) continue;
      const centered = 1 - a / FOV_HALF;
      inView.push({ o, a, centered, score: Sound.loudnessFromMagnitude(o.mag) * (0.3 + centered) });
    }
    inView.sort((x, y) => y.score - x.score);
    const playing = inView.slice(0, MAX_VOICES);

    for (const v of playing) {
      const next = app.nextPing.get(v.o.id) || 0;
      if (now < next) continue;
      const view = Astro.toView(basis, v.o.vec);
      const gain = Math.min(1, Sound.loudnessFromMagnitude(v.o.mag)) * (0.25 + 0.75 * v.centered);
      Sound.ping(view, v.o.freq, gain, v.o.kind === "star" ? "star" : v.o.kind);
      const interval = 1500 - 1150 * v.centered;            // twinkle faster near center
      app.nextPing.set(v.o.id, now + interval * (0.85 + Math.random() * 0.3));
    }

    // lock-on: hold still on the Moon, a planet, or a bright named star to hear what it is
    let lockObj = null, la = LOCK_ANGLE;
    for (const v of inView) {
      const bright = v.o.kind !== "star" || (v.o.star.name && v.o.mag <= LOCK_MAG);
      if (v.a < la && bright) { la = v.a; lockObj = v.o; }
    }
    const still = app.speed < 4; // degrees per second
    if (!lockObj) app.lock.id = null;
    else if (!still) app.lock = { id: lockObj.id, since: now };
    else if (app.lock.id !== lockObj.id) app.lock = { id: lockObj.id, since: now };
    else if (now - app.lock.since > LOCK_HOLD_MS && el("autoNames").checked) {
      const last = app.announced.get(lockObj.id) ?? -Infinity;
      if (now - last > 60000) {
        let text = `You're on ${spokenName(lockObj)}, ${shortType(lockObj)}.`;
        if (app.hintsGiven < 3) text += " Ask me to describe it, or, what's nearby.";
        if (Voice.say(text, { auto: true })) { // skipped if you're listening to an answer
          app.announced.set(lockObj.id, now);
          app.lastTopic = { kind: "obj", id: lockObj.id, at: now };
          // don't follow "You're on Saturn" with "Now in Cetus": "it" should stay Saturn
          app.lastCon = app.announcedCon = constellationAt(f);
          logObject(lockObj);
          app.hintsGiven++;
          Sound.buzz(40);
          return;
        }
      }
    }

    // gently name the constellation you're sweeping through, once you slow down
    if (el("conNames").checked && app.speed < 6) {
      const con = constellationAt(f);
      if (con !== app.lastCon) { app.lastCon = con; app.conSince = now; }
      else if (con && now - app.conSince > 2200 && app.announcedCon !== con) {
        if (Voice.say(`Now in ${conSpoken(con)}.`, { interrupt: false, auto: true })) {
          app.announcedCon = con;
          const recentObject = app.lastTopic && app.lastTopic.kind === "obj" && now - app.lastTopic.at < 30000;
          if (!recentObject) app.lastTopic = { kind: "con", id: con, at: now };
        }
      }
    }
  }

  // ---------- find mode: a sonar beacon that leads you to a target ----------
  // target = { type: "object" | "con" | "dir", id, label }
  function targetVec(t = app.target) {
    if (!t) return null;
    if (t.type === "object") return app.byId.get(t.id).vec;
    if (t.type === "dir") { const d = DIRECTIONS[t.id]; return Astro.altAzToENU(d.alt, d.az); }
    // constellation: average direction of its line stars
    const idxs = [...new Set(S.lines[t.id].flat())];
    let v = [0, 0, 0];
    for (const i of idxs) { const o = app.objects[i]; v = [v[0] + o.vec[0], v[1] + o.vec[1], v[2] + o.vec[2]]; }
    return Astro.normalize(v);
  }

  function findStep(f, now) {
    const tv = targetVec();
    if (!tv) return;
    const angle = Astro.angleBetween(f, tv);
    const basis = Astro.viewBasis(f);
    const dir = Astro.normalize(Astro.toView(basis, tv)); // tick comes FROM the target's direction
    const t = app.target;
    const foundAngle = t.type === "con" ? 8 : t.type === "dir" ? 10 : 3;

    if (angle < foundAngle) { onFound(t); return; }

    if (now >= app.nextTick) {
      Sound.tick(1 - angle / 180, dir);
      app.nextTick = now + Math.max(90, Math.min(1100, angle * 12));
    }

    if (now >= app.nextHint && !Voice.speaking()) {
      const p = Astro.enuToAltAz(f), ta = Astro.enuToAltAz(tv);
      const dAz = ((ta.az - p.az + 540) % 360) - 180;
      const dAlt = ta.alt - p.alt;
      const hints = [];
      const deg = (x) => Math.max(5, Math.round(Math.abs(x) / 5) * 5);
      if (Math.abs(dAz) > 5 && ta.alt < 80) hints.push(`turn ${dAz > 0 ? "right" : "left"} ${deg(dAz)} degrees`);
      if (Math.abs(dAlt) > 5) hints.push(`${dAlt > 0 ? "raise" : "lower"} the phone ${deg(dAlt)} degrees`);
      if (hints.length) Voice.say(angle < 15 ? `Almost there. ${capitalize(hints.join(", and "))}.` : `${capitalize(hints.join(", and "))}.`, { interrupt: false, auto: true });
      app.nextHint = now + (angle < 15 ? 3000 : 5000);
    }
  }

  function onFound(t) {
    Sound.chime();
    Sound.buzz([60, 60, 120]);
    const now = performance.now();
    app.mode = "explore"; app.target = null;
    el("findBtn").textContent = "Start finding";
    let text, conId = null;
    if (t.type === "dir") {
      text = t.id === "up" ? "You're pointing straight up." : `You're facing ${t.label}.`;
    } else if (t.type === "object") {
      const o = app.byId.get(t.id);
      app.announced.set(t.id, now); // don't repeat it on lock-on
      app.lastTopic = { kind: "obj", id: t.id, at: performance.now() };
      logObject(o);
      text = `You're on ${spokenName(o)}, ${shortType(o)}.`;
      if (!app.tour && app.hintsGiven < 3) { text += " Ask me to describe it, or, what's nearby."; app.hintsGiven++; }
      if (app.tour) { const s = storyForObject(o); if (s) text += " " + s; }
    } else {
      conId = t.id;
      app.lastTopic = { kind: "con", id: conId, at: performance.now() };
      Log.add(S.cons[conId], "con");
      text = `Found ${t.label}.`;
      if (app.tour && STORIES.cons[conId]) text += " " + STORIES.cons[conId];
    }
    if (app.tour) {
      const last = app.tour.i >= app.tour.stops.length - 1;
      text += last ? " That was the last stop. Thanks for touring the sky!" : " Say next, or tap Next stop, when you're ready.";
      if (last) endTour(false);
    } else if (conId) {
      text += " Playing its shape.";
    }
    Voice.say(text);
    if (conId) waitForSpeech().then(() => playConstellation(conId));
  }

  async function waitForSpeech() {
    await wait(400);
    for (let i = 0; i < 120 && Voice.speaking(); i++) await wait(250);
    await wait(300);
  }

  function findTarget(target, { quiet = false } = {}) {
    if (!target) return;
    if (target.type === "object" && !app.byId.get(target.id)) return;
    if (target.type !== "dir") {
      const v = targetVec(target);
      if (v[2] < -0.02) { // below the horizon: say when it rises instead of pointing at the ground
        const rise = nextRiseSet(target, "rise");
        Voice.say(`${capitalize(target.label)} is below the horizon right now, so you can't point at it.${rise ? ` It rises ${timeWords(rise)}.` : ""} Say what's up tonight to hear what you can find.`);
        if (app.tour) nextStop();
        return;
      }
    }
    app.melodyToken++; app.playingMelody = false;
    app.target = target;
    app.mode = "find"; app.nextTick = 0;
    el("findBtn").textContent = "Stop finding";
    const tv = targetVec();
    let intro;
    if (target.type === "dir") {
      intro = `Finding ${target.label}. Follow the ticking; it gets faster as you get closer.`;
    } else {
      const where = whereWords({ vec: tv });
      intro = `Finding ${target.label}. It's ${where}, ${relativeWords(Sensors.state.vec, tv)}.`;
      intro += quiet ? "" : " Follow the ticking. It gets faster as you get closer.";
    }
    Voice.say(intro);
    app.nextHint = performance.now() + 6000;
  }

  function startFind() {
    if (app.mode === "find") { stopAll(); return; }
    const val = el("target").value;
    if (!val) return;
    const [type, id] = val.split(":");
    findTarget({ type, id, label: el("target").selectedOptions[0].textContent });
  }

  function stopAll(say = true) {
    const was = app.mode === "find" || app.tour || app.playingMelody;
    app.melodyToken++; app.playingMelody = false;
    app.mode = "explore"; app.target = null;
    el("findBtn").textContent = "Start finding";
    if (app.tour) endTour(false);
    if (say) Voice.say(was ? "Stopped. Back to exploring." : "Exploring.");
  }

  // ---------- guided tour of tonight's sky ----------
  const TOUR_CONS = ["Ori", "UMa", "Cyg", "Sco", "Sgr", "Cas", "Leo", "Lyr", "Tau", "Gem", "Peg", "CMa", "Boo", "Aql", "And", "Aur", "UMi"];

  function buildTourStops() {
    const stops = [];
    const up = (v, minAlt = 15) => Astro.enuToAltAz(v).alt > minAlt;
    const moon = app.byId.get("pMoon");
    if (moon && up(moon.vec, 10)) stops.push({ type: "object", id: "pMoon", label: "the Moon" });
    for (const n of ["Jupiter", "Saturn", "Venus", "Mars"]) {
      const p = app.byId.get("p" + n);
      if (p && up(p.vec, 12)) stops.push({ type: "object", id: "p" + n, label: n });
    }
    const consUp = TOUR_CONS
      .map((id) => ({ id, alt: Astro.enuToAltAz(targetVec({ type: "con", id })).alt }))
      .filter((c) => c.alt > 25);
    for (const c of consUp) {
      if (stops.length >= 6) break;
      stops.push({ type: "con", id: c.id, label: S.cons[c.id] });
    }
    // one bright named star if there's room
    const star = app.objects.filter((o) => o.kind === "star" && o.star.name && STORIES.stars[o.star.name] && up(o.vec, 20))
      .sort((a, b) => a.mag - b.mag)[0];
    if (star) {
      // don't visit a star and its own constellation separately
      const dup = stops.findIndex((s) => s.type === "con" && s.id === star.star.con);
      if (dup >= 0) stops.splice(dup, 1);
      stops.splice(Math.min(2, stops.length), 0, { type: "object", id: star.id, label: star.star.name });
    }
    return stops.slice(0, 6);
  }

  function startTour() {
    const stops = buildTourStops();
    if (!stops.length) { Voice.say("Nothing bright enough is up for a tour right now."); return; }
    app.tour = { stops, i: 0 };
    el("nextBtn").hidden = false;
    const names = stops.map((s) => s.label);
    Voice.say(`Tour of the sky, ${stops.length} stops: ${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}. First stop.`);
    waitForSpeech().then(() => { if (app.tour) findTarget(stops[0], { quiet: false }); });
  }

  function nextStop() {
    if (!app.tour) { Voice.say("No tour is running. Say take me on a tour to start one."); return; }
    app.tour.i++;
    if (app.tour.i >= app.tour.stops.length) { endTour(true); return; }
    findTarget(app.tour.stops[app.tour.i], { quiet: true });
  }

  function endTour(say) {
    app.tour = null;
    el("nextBtn").hidden = true;
    if (say) Voice.say("That's the end of the tour.");
  }

  // ---------- constellation melody ----------
  async function playConstellation(conId) {
    conId = conId || constellationAt(Sensors.state.vec);
    if (!conId || !S.lines[conId]) { Voice.say("No constellation pattern here. Try another part of the sky."); return; }
    const token = ++app.melodyToken;
    app.playingMelody = true;
    app.announcedCon = conId;
    app.lastTopic = { kind: "con", id: conId, at: performance.now() };
    Voice.say(`The shape of ${conSpoken(conId)}.`);
    await wait(1100);
    const basis = Astro.viewBasis(Sensors.state.vec);
    for (const seg of S.lines[conId]) {
      for (const i of seg) {
        if (token !== app.melodyToken) return;
        const o = app.objects[i];
        const view = Astro.toView(basis, o.vec);
        Sound.ping(view, o.freq, Math.max(0.25, Math.min(1, Sound.loudnessFromMagnitude(o.mag) * 2)), "star", 0.7);
        await wait(280);
      }
      await wait(220); // little breath between line segments
    }
    if (token === app.melodyToken) app.playingMelody = false;
  }

  // ---------- "tell me about X" without moving ----------
  function aboutTarget(target) {
    if (!target) return;
    if (target.type === "object") {
      const o = app.byId.get(target.id);
      app.lastTopic = { kind: "obj", id: o.id, at: performance.now() };
      const s = storyForObject(o);
      Voice.say(`${describe(o, { withPlace: true })}${s ? " " + s : ""} Say find ${target.label} to go there.`);
    } else if (target.type === "con") {
      app.lastTopic = { kind: "con", id: target.id, at: performance.now() };
      const where = whereWords({ vec: targetVec(target) });
      Voice.say(`${conSpoken(target.id)}. It is ${where}. ${STORIES.cons[target.id] || ""}`);
    } else {
      findTarget(target);
    }
  }

  // ---------- voice commands ----------
  function runCommand(cmd) {
    const a = cmd.action;
    if (["find", "about", "describe", "riseSet", "visible", "distance", "logHas"].includes(a)) {
      const target = resolveRef(cmd.ref);
      if (!target) {
        Voice.say(cmd.ref === "topic" ? "I'm not sure what you mean. Point at something and hold still, or say a name, like Jupiter."
          : "I couldn't find that in tonight's sky data.");
        return;
      }
      // asking about something by name makes it the new "it"
      if (cmd.ref !== "topic" && (target.type === "object" || target.type === "con")) {
        app.lastTopic = { kind: target.type === "object" ? "obj" : "con", id: target.id, at: performance.now() };
      }
      if (a === "describe") return describeTarget(target);
      if (a === "riseSet") return answerRiseSet(target, cmd.dir);
      if (a === "visible") return answerVisible(target);
      if (a === "distance") return answerDistance(target);
      if (a === "logHas") return logHas(target);
      if (target.type === "sun") {
        return Voice.say(`StarSound doesn't guide you to the Sun, so nobody nearby looks straight at it. ${sunAltitudeAt(new Date()) > 0 ? "It's up now." : "It's below the horizon now."} You can ask when the Sun rises or sets.`);
      }
      if (a === "find") findTarget(target); else describeTarget(target);
      return;
    }
    switch (a) {
      case "here": return whatsHere();
      case "nearby": return nearby();
      case "brightest": return brightest();
      case "settings": return settingsSummary();
      case "resetSettings": {
        el("focus").value = setFocus("normal"); setDetail("bright"); el("detail").value = "bright";
        el("autoNames").checked = true; el("conNames").checked = true;
        el("volume").value = Sound.setVolume(0.8); el("rate").value = Voice.setRate(1);
        Prefs.save({ focus: "normal", detail: "bright", autoNames: true, conNames: true, volume: 0.8, rate: 1 });
        return Voice.say("Settings are back to normal.");
      }
      case "detail": {
        const order = ["fewest", "bright", "more"];
        const cur = el("detail").value;
        const next = order[Math.max(0, Math.min(2, order.indexOf(cur) + (cmd.dir === "more" ? 1 : -1)))];
        setDetail(next); el("detail").value = next; Prefs.save({ detail: next });
        const words = { fewest: "only the brightest stars", bright: "bright stars", more: "many stars" };
        return Voice.say(next === cur ? `You're already hearing ${words[next]}.` : `Now playing ${words[next]}.`);
      }
      case "autoNames":
        el("autoNames").checked = cmd.on; Prefs.save({ autoNames: cmd.on });
        return Voice.say(cmd.on ? "I'll name bright stars and planets when you hold still on them." : "I'll stop naming stars as you point. Ask what am I pointing at, any time.");
      case "conNames":
        el("conNames").checked = cmd.on; Prefs.save({ conNames: cmd.on });
        return Voice.say(cmd.on ? "I'll name constellations as you sweep." : "I'll stop naming constellations.");
      case "screenReader":
        el("srMode").checked = cmd.on; Prefs.save({ sr: cmd.on });
        if (!cmd.on) Voice.setScreenReader(false);
        Voice.say(cmd.on ? "Switching to your screen reader." : "Using StarSound's own voice.");
        if (cmd.on) setTimeout(() => Voice.setScreenReader(true), 2500);
        return;
      case "focus": {
        const order = ["narrow", "normal", "wide"];
        const cur = el("focus").value;
        const next = order[Math.max(0, Math.min(2, order.indexOf(cur) + (cmd.dir === "wider" ? 1 : -1)))];
        el("focus").value = setFocus(next); Prefs.save({ focus: next });
        return Voice.say(next === cur ? `The listening circle is already ${next}.` : `Listening circle: ${next}.`);
      }
      case "faq": return Voice.say(cmd.answer);
      case "log": return logSummary(cmd.period);
      case "logClear": app.confirmClear = Date.now(); return Voice.say("This erases everything you've logged. To be sure, say confirm clear.");
      case "logClearConfirm":
        if (app.confirmClear && Date.now() - app.confirmClear < 30000) { Log.clear(); app.confirmClear = 0; return Voice.say("Your log is cleared."); }
        return Voice.say("To erase your log, first say clear my log.");
      case "moonPhase": return answerMoonPhase();
      case "nextFull": return answerNextPhase("full");
      case "nextNew": return answerNextPhase("new");
      case "dark": return answerDark();
      case "meteors": return answerMeteors();
      case "handsFreeOn": return setHandsFree(true);
      case "handsFreeOff": return setHandsFree(false);
      case "tonight": return skyTonight();
      case "constellation": return playConstellation();
      case "tour": return startTour();
      case "next": return nextStop();
      case "more": return tellMore();
      case "stop": return stopAll();
      case "help": return Voice.say(Commands.HELP);
      case "helpAll": return Voice.say(Commands.HELP_ALL);
      case "privacy": return Voice.say("StarSound has no account, no tracking and no ads. Your location and the phone's motion stay on this phone. " +
        "The microphone is only on while you talk, or in hands-free mode, and your phone's own speech service turns your words into text. " +
        "StarSound never records or stores your voice. Your observing log stays on this phone, and you can say clear my log to erase it.");
      case "tutorial": return tutorial();
      case "pause": return setPaused(true);
      case "resume": return setPaused(false);
      case "repeat": return Voice.repeat();
      case "calibrate": return calibrate();
      case "louder": case "quieter": {
        const v = Sound.setVolume(Sound.getVolume() + (a === "louder" ? 0.25 : -0.25));
        el("volume").value = v; Prefs.save({ volume: v });
        Sound.ping([0, 0, 1], 660, 0.6, "star", 0.4);
        return Voice.say(a === "louder" ? "Louder." : "Quieter.");
      }
      case "slower": case "faster": {
        const r = Voice.setRate(Voice.getRate() + (a === "faster" ? 0.15 : -0.15));
        el("rate").value = r; Prefs.save({ rate: r });
        return Voice.say(a === "faster" ? "Speaking faster." : "Speaking slower.");
      }
      case "timeNow": el("timeMode").value = "now"; app.timeMode = "now"; rebuildSky(); return Voice.say("Showing the sky right now.");
      case "timeTonight": el("timeMode").value = "tonight"; app.timeMode = "tonight"; rebuildSky(); return Voice.say("Showing the sky at 9 PM tonight.");
      case "findUnknown":
        Sound.earcon("error");
        return Voice.say(`I don't know ${cmd.said || "that"} yet. Try a planet, a bright star, or a constellation, like Find Orion.`);
      default:
        Sound.earcon("error");
        return Voice.say(cmd.heard ? `Sorry, I heard: ${cmd.heard}. Say help to hear what you can say.` : "I didn't catch that.");
    }
  }

  function talk() {
    if (!app.running) return;
    if (!Listen.supported()) {
      Voice.say("Voice commands aren't supported in this browser. Try Chrome on Android, or Safari on iPhone. All the buttons still work.");
      return;
    }
    Voice.cancel();
    Voice.unlock();
    Listen.start();
  }

  function onWake() {
    Voice.cancel();
    Sound.earcon("listen");
    Sound.buzz(30);
  }

  function onListenState(state, err) {
    if (state === "start") {
      app.listening = true;
      el("talkBtn").textContent = "Listening… tap to stop";
      el("talkBtn").setAttribute("aria-pressed", "true");
      Sound.earcon("listen");
      return;
    }
    if (state === "unsupported") return;
    app.listening = false;
    el("talkBtn").textContent = "Tap to talk";
    el("talkBtn").setAttribute("aria-pressed", "false");
    if (state === "end" && !err) return;
    const reasons = {
      "not-allowed": "Microphone access is blocked. Allow the microphone in your browser settings, or use the buttons.",
      "service-not-allowed": "Voice commands aren't available here. On iPhone, make sure Siri and dictation are turned on.",
      "network": "Voice commands need an internet connection. Everything else still works offline.",
      "audio-capture": "I couldn't find a microphone.",
      "no-speech": "I didn't hear anything. Tap Talk and try again.",
      "aborted": null,
    };
    const msg = err in reasons ? reasons[err] : "Something went wrong with the microphone. Try again.";
    if (msg) { Sound.earcon("error"); Voice.say(msg); }
  }

  function settingsSummary() {
    const pct = Math.round(Sound.getVolume() / 0.8 * 100);
    const r = Voice.getRate();
    const speed = r < 0.9 ? "slower than normal" : r > 1.1 ? "faster than normal" : "normal";
    const stars = { fewest: "only the brightest", bright: "bright stars", more: "many stars" }[el("detail").value];
    Voice.say(`Your settings. Star volume ${pct} percent. Speaking speed ${speed}. Listening circle ${el("focus").value}. ` +
      `Stars you hear: ${stars}. Naming stars as you point: ${el("autoNames").checked ? "on" : "off"}. ` +
      `Naming constellations: ${el("conNames").checked ? "on" : "off"}. Hands-free: ${Listen.handsFree() ? "on" : "off"}. ` +
      `To change one, say things like: fewer stars, wider, speak slower, or stop announcing.`);
  }

  function setPaused(p) {
    app.paused = p;
    el("pauseBtn").textContent = app.paused ? "Resume sounds" : "Pause sounds";
    el("pauseBtn").setAttribute("aria-pressed", String(app.paused));
    Voice.say(p ? "Star sounds paused." : "Star sounds on.");
  }

  function tutorial() {
    Voice.say(
      "Here's how StarSound works. Hold your phone up like you're taking a photo of the sky, and use headphones. " +
      "Every star in front of the phone plays a note. Brighter stars are louder. Blue, hot stars sound high, and red, cooler stars sound low. " +
      "Stars to your left sound on your left. Stars twinkle faster as you aim right at them, and if you hold still on a bright star, I'll tell you its name. " +
      "The Moon and planets have their own sounds. To find something, tap Talk and say Find, then its name, and follow the ticking. " +
      "Say help any time to hear all the commands.");
  }

  // ---------- observing log: "what have I seen this month?" ----------
  // Every planet, bright star or constellation you find (or hold still on) is saved
  // on this phone with the date. Nothing leaves the device.
  const Log = {
    KEY: "starsound-log",
    all() { try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); } catch (_) { return []; } },
    add(name, kind) {
      if (!name) return;
      const list = this.all();
      const now = Date.now();
      // count each object once per night
      if (list.some((e) => e.n === name && now - e.t < 10 * 3600 * 1000)) return;
      list.push({ n: name, k: kind, t: now });
      try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(-2000))); } catch (_) {}
    },
    clear() { try { localStorage.removeItem(this.KEY); } catch (_) {} },
    since(periodName) {
      const now = new Date();
      let start;
      if (periodName === "night") start = new Date(now.getTime() - 14 * 3600 * 1000);
      else if (periodName === "week") start = new Date(now.getTime() - 7 * 86400 * 1000);
      else if (periodName === "month") start = new Date(now.getFullYear(), now.getMonth(), 1);
      else if (periodName === "year") start = new Date(now.getFullYear(), 0, 1);
      else if (periodName === "lastnight") {
        const k = nightKey(Date.now()) - 86400000;
        return this.all().filter((e) => nightKey(e.t) === k);
      }
      else start = new Date(0);
      return this.all().filter((e) => e.t >= start.getTime());
    },
  };

  // an observing "night" runs noon to noon, so 1 AM sightings count for the evening before
  function nightKey(t) { const d = new Date(t - 12 * 3600 * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  function renderJournal() {
    const box = el("journalList");
    box.textContent = "";
    const entries = Log.all();
    if (!entries.length) {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = "Nothing yet. Everything you find, or hold still on, is saved here automatically.";
      box.appendChild(p); return;
    }
    const nights = new Map();
    for (const e of entries) { const k = nightKey(e.t); if (!nights.has(k)) nights.set(k, []); nights.get(k).push(e); }
    for (const [k, list] of [...nights.entries()].sort((a, b) => b[0] - a[0]).slice(0, 60)) {
      const h = document.createElement("h3"); h.className = "group-title";
      const today = nightKey(Date.now());
      h.textContent = k === today ? "Tonight" : k === today - 86400000 ? "Last night" : new Date(k).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
      const p = document.createElement("p"); p.className = "journal-night";
      p.textContent = [...new Set(list.map((e) => (e.n === "Moon" ? "the Moon" : e.n)))].join(", ");
      box.append(h, p);
    }
  }

  function logObject(o) {
    if (o.kind === "star") Log.add(o.star.name || o.star.bayer, "star");
    else Log.add(o.name, o.kind);
  }

  function listWords(arr) {
    if (arr.length <= 1) return arr.join("");
    return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
  }

  function logSummary(periodName) {
    const label = { night: "tonight", lastnight: "last night", week: "this week", month: "this month", year: "this year", all: "so far" }[periodName];
    const entries = Log.since(periodName);
    if (!entries.length) {
      Voice.say(`You haven't logged anything ${label} yet. Every planet, bright star, or constellation you find or hold still on gets saved automatically.`);
      return;
    }
    const uniq = (kinds) => [...new Set(entries.filter((e) => kinds.includes(e.k)).map((e) => e.n))];
    const planets = uniq(["planet", "moon"]).map((n) => (n === "Moon" ? "the Moon" : n));
    const stars = uniq(["star"]);
    const cons = uniq(["con"]);
    const parts = [];
    if (planets.length) parts.push(`${planets.length === 1 ? "one planet or moon" : planets.length + " planets and moons"}: ${listWords(planets)}`);
    if (stars.length) parts.push(`${stars.length === 1 ? "one star" : stars.length + " stars"}: ${listWords(stars.slice(0, 8))}${stars.length > 8 ? ", and more" : ""}`);
    if (cons.length) parts.push(`${cons.length === 1 ? "one constellation" : cons.length + " constellations"}: ${listWords(cons.slice(0, 8))}${cons.length > 8 ? ", and more" : ""}`);
    const nights = new Set(entries.map((e) => new Date(e.t).toDateString())).size;
    const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join("; ") + "; and " + parts[parts.length - 1];
    Voice.say(`${capitalize(label)}, over ${nights === 1 ? "one night" : nights + " nights"}, you've found ${joined}.`);
  }

  function logHas(target) {
    const name = target.type === "object" ? nameOf(app.byId.get(target.id)) : target.label;
    const hits = Log.all().filter((e) => e.n === name);
    if (!hits.length) { Voice.say(`Not yet. Say find ${target.label} to look for it.`); return; }
    const last = new Date(hits[hits.length - 1].t);
    Voice.say(`Yes. You've found ${target.label} ${hits.length === 1 ? "once" : hits.length + " times"}, most recently on ${dayWords(last)}.`);
  }

  // ---------- sky questions: rise and set, moon phase, darkness, distance ----------
  function observer() { return new Astronomy.Observer(app.loc.lat, app.loc.lon, 0); }

  function timeWords(d) {
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${dayWords(d, true)} at ${t}`;
  }

  function dayWords(d, relative = true) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    if (relative && diff === 0) return d.getHours() >= 17 ? "tonight" : "today";
    if (relative && diff === 1) return "tomorrow";
    if (relative && diff === -1) return "yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }

  const BODY_NAMES = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"];

  // next rise or set within 2 days. Solar system bodies use astronomy-engine's search;
  // stars and constellations step through time with our own sky math.
  function nextRiseSet(target, dir) {
    const now = new Date();
    if (target.type === "sun" || (target.type === "object" && target.id.startsWith("p"))) {
      const body = target.type === "sun" ? "Sun" : target.id.slice(1);
      const res = Astronomy.SearchRiseSet(body, observer(), dir === "rise" ? +1 : -1, now, 2);
      return res ? res.date : null;
    }
    const raDec = targetRaDec(target);
    let prevUp = null;
    for (let m = 0; m <= 48 * 60; m += 4) {
      const d = new Date(now.getTime() + m * 60000);
      const lst = Astro.localSiderealTime(d, app.loc.lon);
      const up = Astro.equatorialToENU(raDec.ra, raDec.dec, app.loc.lat, lst)[2] > 0;
      if (prevUp !== null && up !== prevUp && (dir === "rise") === up) return d;
      prevUp = up;
    }
    return null;
  }

  function targetRaDec(target) {
    return Astro.enuToEquatorial(targetVec(target), app.loc.lat, app.lst);
  }

  function sunAltitudeAt(d) {
    const obs = observer();
    const eq = Astronomy.Equator("Sun", d, obs, true, true);
    return Astronomy.Horizon(d, obs, eq.ra, eq.dec).altitude;
  }

  function answerRiseSet(target, dir) {
    if (!target) return;
    const label = target.type === "sun" ? "the Sun" : target.label;
    const verb = dir === "rise" ? "rises" : "sets";
    const d = nextRiseSet(target, dir);
    if (d) { Voice.say(`${capitalize(label)} ${verb} ${timeWords(d)}.`); return; }
    const alt = target.type === "sun" ? sunAltitudeAt(new Date()) : Astro.enuToAltAz(targetVec(target)).alt;
    Voice.say(alt > 0 ? `${capitalize(label)} never sets from here; it circles the North Star all night.`
      : `${capitalize(label)} doesn't rise from here in the next two days.`);
  }

  function answerVisible(target) {
    if (target.type === "sun") {
      const alt = sunAltitudeAt(new Date());
      Voice.say(alt > 0 ? `Yes, the Sun is up. It sets ${timeWords(nextRiseSet(target, "set"))}.`
        : `No, the Sun is down. It rises ${timeWords(nextRiseSet(target, "rise"))}.`);
      return;
    }
    const vec = targetVec(target);
    const { alt } = Astro.enuToAltAz(vec);
    const label = capitalize(target.label);
    if (target.type === "dir") { findTarget(target); return; }
    if (alt > 0) {
      const set = nextRiseSet(target, "set");
      let t = `Yes. ${label} is ${whereWords({ vec })}.`;
      if (alt < 10) t += " That's very low, so trees or buildings may block it.";
      if (set) t += ` It sets ${timeWords(set)}.`;
      if (app.timeMode === "now" && sunAltitudeAt(new Date()) > -6) t += " The sky is still bright, though, so only the Moon and the brightest planets show up right now.";
      Voice.say(t);
    } else {
      const rise = nextRiseSet(target, "rise");
      Voice.say(`No, ${target.label} is below the horizon right now.${rise ? ` It rises ${timeWords(rise)}.` : ""}`);
    }
  }

  function distanceSentence(target) {
    const AU_MILES = 92955807;
    if (target.type === "sun" || (target.type === "object" && target.id.startsWith("p"))) {
      const body = target.type === "sun" ? "Sun" : target.id.slice(1);
      const au = Astronomy.GeoVector(body, new Date(), true).Length();
      const lightMin = au * 8.3167;
      if (body === "Moon") {
        return (`The Moon is about ${Math.round(au * AU_MILES / 1000).toLocaleString()} thousand miles away right now. Its light takes about ${(lightMin * 60).toFixed(1)} seconds to reach you.`);
      } else {
        const miles = au * AU_MILES / 1e6;
        const big = miles >= 1000 ? `${(miles / 1000).toFixed(1)} billion` : `${Math.round(miles)} million`;
        const lt = lightMin >= 60 ? `${(lightMin / 60).toFixed(1)} hours` : `${Math.round(lightMin)} minutes`;
        return (`${body === "Sun" ? "The Sun" : body} is about ${big} miles away right now. Its light takes about ${lt} to reach you.`);
      }
      return;
    }
    if (target.type === "object") {
      const o = app.byId.get(target.id);
      return (o.star.ly ? `${target.label} is about ${o.star.ly.toLocaleString()} light-years away. The light you'd see tonight left it about ${o.star.ly.toLocaleString()} years ago.`
        : `I don't have a reliable distance for ${target.label}.`);
      return;
    }
    if (target.type === "con") {
      const ds = [...new Set(S.lines[target.id].flat())].map((i) => S.stars[i].ly).filter(Boolean).sort((a, b) => a - b);
      return (ds.length ? `The stars of ${target.label} aren't the same distance away. Its main stars range from about ${ds[0].toLocaleString()} to ${ds[ds.length - 1].toLocaleString()} light-years.`
        : `The stars of ${target.label} are at many different distances.`);
      return;
    }
    return ("That's a direction, not an object.");
  }
  function answerDistance(target) { Voice.say(distanceSentence(target)); }


  function answerMoonPhase() {
    const ph = Astro.moonPhase(new Date());
    const full = Astronomy.SearchMoonPhase(180, new Date(), 40);
    const neu = Astronomy.SearchMoonPhase(0, new Date(), 40);
    const moon = { type: "object", id: "pMoon", label: "the Moon" };
    const up = Astro.enuToAltAz(app.byId.get("pMoon").vec).alt > 0;
    const next = up ? `It's up now and sets ${timeWords(nextRiseSet(moon, "set"))}.` : `It rises ${timeWords(nextRiseSet(moon, "rise"))}.`;
    const nextPhase = full.date < neu.date ? `The next full moon is ${dayWords(full.date)}.` : `The next new moon is ${dayWords(neu.date)}.`;
    const phase = /moon/.test(ph.name) ? `a ${ph.name}` : /quarter/.test(ph.name) ? `at ${ph.name}` : `a ${ph.name} moon`;
    Voice.say(`The Moon is ${phase}, ${ph.lit} percent lit. ${next} ${nextPhase}`);
  }

  function answerNextPhase(which) {
    const res = Astronomy.SearchMoonPhase(which === "full" ? 180 : 0, new Date(), 40);
    const days = Math.round((res.date - new Date()) / 86400000);
    Voice.say(`The next ${which} moon is ${dayWords(res.date)}${days > 1 ? `, in ${days} days` : ""}.`);
  }

  function answerDark() {
    const obs = observer();
    const now = new Date();
    const alt = sunAltitudeAt(now);
    if (alt < -18) {
      const rise = Astronomy.SearchRiseSet("Sun", obs, +1, now, 1);
      Voice.say(`It's fully dark right now. The sky starts brightening about an hour and a half before sunrise, which is ${rise ? timeWords(rise.date) : "later"}.`);
      return;
    }
    const start = alt < 0 ? new Date(now.getTime() - 6 * 3600 * 1000) : now;
    const set = Astronomy.SearchRiseSet("Sun", obs, -1, start, 1);
    const civil = Astronomy.SearchAltitude("Sun", obs, -1, start, 1, -6);
    const astro = Astronomy.SearchAltitude("Sun", obs, -1, start, 1, -18);
    const hm = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sentences = [];
    if (set && set.date > now) sentences.push(`Sunset is ${timeWords(set.date)}.`);
    if (civil && civil.date > now) sentences.push(`The Moon, the brightest planets and the brightest stars show up around ${hm(civil.date)}.`);
    else sentences.push("The brightest stars and planets are already out.");
    if (astro) sentences.push(`It's fully dark by ${hm(astro.date)}.`);
    Voice.say(sentences.join(" ") + " Remember, StarSound works any time, even before dark.");
  }

  // Peak dates are approximate and shift by a day or so each year.
  const METEOR_SHOWERS = [
    { name: "Quadrantids", m: 0, d: 3, where: "the northeast, near the Big Dipper's handle" },
    { name: "Lyrids", m: 3, d: 22, where: "near Vega, in Lyra" },
    { name: "Eta Aquariids", m: 4, d: 6, where: "the east, before dawn" },
    { name: "Perseids", m: 7, d: 12, where: "the northeast, in Perseus" },
    { name: "Orionids", m: 9, d: 21, where: "Orion, which rises late in the evening" },
    { name: "Leonids", m: 10, d: 17, where: "Leo, which rises after midnight" },
    { name: "Geminids", m: 11, d: 14, where: "Gemini, high in the sky after about 10 PM" },
  ];

  function answerMeteors() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dated = METEOR_SHOWERS.map((s) => {
      let d = new Date(now.getFullYear(), s.m, s.d);
      if (d < new Date(today.getTime() - 2 * 86400000)) d = new Date(now.getFullYear() + 1, s.m, s.d);
      return { ...s, date: d };
    }).sort((a, b) => a.date - b.date);
    const s = dated[0];
    const days = Math.round((s.date - today) / 86400000);
    const when = days <= 0 ? "peaking right about now" : days === 1 ? "peaking tomorrow night" : days <= 7 ? `peaking in ${days} days, around ${dayWords(s.date, false)}` : `peaking around ${dayWords(s.date, false)}`;
    const after = dated[1];
    Voice.say(`The next big meteor shower is the ${s.name}, ${when}. The meteors seem to come from ${s.where}, and the best time is usually after midnight, away from city lights. After that comes the ${after.name}, around ${after.date.toLocaleDateString([], { month: "long", day: "numeric" })}.`);
  }

  function setHandsFree(on, { quiet = false } = {}) {
    if (on && !Listen.supported()) {
      Voice.say("Hands-free listening isn't supported in this browser. Try Chrome on Android, or Safari on iPhone.");
      return;
    }
    Listen.setHandsFree(on);
    el("handsFreeBtn").textContent = on ? "Hands-free: on" : "Hands-free: off";
    el("handsFreeBtn").setAttribute("aria-pressed", String(on));
    Prefs.save({ handsFree: on });
    if (!quiet) Voice.say(on ? "Hands-free is on. Start each command with Hey Star, like: Hey Star, find Jupiter. Headphones work best." : "Hands-free is off. Tap the screen to talk.", { interrupt: false });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- sky tonight ----------
  function skyTonight() {
    // During the day, "tonight" means this evening, so describe the sky at 9 PM.
    const daytime = app.timeMode === "now" && solarAltitude() > -6;
    const saved = app.timeMode;
    if (daytime) { app.timeMode = "tonight"; rebuildSky(); }
    const up = app.objects.filter((o) => o.vec[2] > 0.09); // above about 5 degrees
    const bodies = up.filter((o) => o.kind !== "star");
    const stars = up.filter((o) => o.kind === "star" && o.star.name).sort((a, b) => a.mag - b.mag).slice(0, 3);
    const parts = [];
    const when = app.timeMode === "tonight" ? "At 9 tonight" : "Right now";
    const label = (b) => (b.name === "Moon" ? "the Moon" : b.name);
    if (bodies.length) parts.push(`${when}, ${listWords(bodies.map((b) => `${label(b)} is ${whereWords(b)}`))}`);
    else parts.push(`${when}, the Moon and the bright planets are all below the horizon`);
    if (stars.length) parts.push(`The brightest stars up are ${listWords(stars.map((s) => `${s.star.name}, in the ${Astro.compassWord(Astro.enuToAltAz(s.vec).az)}`))}`);
    const ph = Astro.moonPhase(app.date);
    if (ph) parts.push(`The Moon is ${/moon/.test(ph.name) ? "a " + ph.name : /quarter/.test(ph.name) ? "at " + ph.name : "a " + ph.name + " moon"}`);
    parts.push("Say take me on a tour to visit the highlights");
    if (daytime) { app.timeMode = saved; rebuildSky(); }
    Voice.say(parts.join(". ") + ".");
  }


  function solarAltitude() {
    if (typeof Astronomy === "undefined") return -90;
    const obs = new Astronomy.Observer(app.loc.lat, app.loc.lon, 0);
    const eq = Astronomy.Equator("Sun", app.date, obs, true, true);
    return Astronomy.Horizon(app.date, obs, eq.ra, eq.dec).altitude;
  }

  function whatsHere() {
    const f = Sensors.state.vec;
    const p = Astro.enuToAltAz(f);
    if (p.alt < -5 && !el("below").checked) {
      Voice.say(`You're pointing ${Math.round(-p.alt)} degrees below the horizon, toward the ${Astro.compassWord(p.az)}. Raise the phone to hear the sky.`);
      return;
    }
    // prefer things with everyday names: the Moon, planets, and named bright stars
    let best = null, bd = Infinity;
    for (const o of app.objects) {
      const plain = o.kind !== "star" || (o.star.name && o.mag < 3);
      if (!plain || (o.vec[2] < 0 && !el("below").checked)) continue;
      const a = Astro.angleBetween(f, o.vec);
      if (a > 25) continue;
      const score = a + (o.kind === "star" ? o.mag * 3 : -6);
      if (score < bd) { bd = score; best = o; }
    }
    const con = constellationAt(f);
    let t = `You're pointing ${Math.round(p.alt)} degrees up, toward the ${Astro.compassWord(p.az)}`;
    t += con ? `, in ${conSpoken(con)}.` : ".";
    if (best) {
      const a = Astro.angleBetween(f, best.vec);
      t += a < LOCK_ANGLE + 1 ? ` You're right on ${nameOf(best) === "Moon" ? "the Moon" : nameOf(best)}. ${describe(best)}`
        : ` The nearest bright object is ${nameOf(best) === "Moon" ? "the Moon" : nameOf(best)}, ${relativeWords(f, best.vec)}.`;
      app.lastTopic = { kind: "obj", id: best.id, at: performance.now() };
    } else {
      t += " There are no bright stars right here. Try sweeping slowly, or ask what's up tonight.";
      if (con) app.lastTopic = { kind: "con", id: con, at: performance.now() };
    }
    Voice.say(t);
  }


  function calibrate() {
    const bodies = app.objects.filter((o) => o.kind !== "star" && o.vec[2] > 0)
      .sort((a, b) => a.mag - b.mag);
    const bright = app.objects.filter((o) => o.kind === "star" && o.vec[2] > 0.2 && o.star.name)
      .sort((a, b) => a.mag - b.mag);
    const ref = bodies[0] || bright[0];
    if (!ref) { Voice.say("Nothing bright enough to calibrate on right now."); return; }
    const d = Sensors.calibrateTo(ref.vec);
    Voice.say(`Calibrated on ${ref.kind === "moon" ? "the Moon" : nameOf(ref)}. Corrected by ${Math.round(Math.abs(d))} degrees.`);
  }

  // ---------- sighted-companion view (for friends, teachers, and the demo video) ----------
  const canvas = el("sky"), g = canvas.getContext("2d");
  const COLORS = { night: "#070B1F", horizon: "#1A2147", lines: "rgba(243,230,207,0.16)", label: "rgba(243,230,207,0.82)",
    planet: "#F6D28B", moon: "#F3E6CF", cone: "#9CC9FF", ember: "#FF7A45" };
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function draw(f) {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // night gradient: a little lighter toward the horizon, like real sky glow
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, COLORS.night); sky.addColorStop(1, "#0E1433");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    if (!app.objects.length) return;
    const basis = Astro.viewBasis(f);
    // the aim point sits in the visible area above the control panel
    const cx = w / 2, cy = h * (w < 700 ? 0.34 : 0.42);
    const scale = Math.min(w, h) / 2 / Math.tan(32 * Astro.DEG);
    const proj = (v) => {
      const p = Astro.toView(basis, v);
      if (p[2] < 0.2) return null;
      return [cx + (p[0] / p[2]) * scale, cy - (p[1] / p[2]) * scale];
    };
    // ground: shade everything below the horizon
    g.beginPath(); let started = false; const pts = [];
    for (let az = 0; az <= 360; az += 2) {
      const q = proj(Astro.altAzToENU(0, az));
      if (q) pts.push(q);
      if (!q) { started = false; continue; }
      if (!started) { g.moveTo(q[0], q[1]); started = true; } else g.lineTo(q[0], q[1]);
    }
    g.strokeStyle = COLORS.horizon; g.lineWidth = 1.5; g.stroke();
    // constellation lines
    g.strokeStyle = COLORS.lines; g.lineWidth = 1;
    for (const segs of Object.values(S.lines)) {
      for (const seg of segs) {
        g.beginPath(); let on = false;
        for (const i of seg) {
          const q = proj(app.objects[i].vec);
          if (!q) { on = false; continue; }
          if (!on) { g.moveTo(q[0], q[1]); on = true; } else g.lineTo(q[0], q[1]);
        }
        g.stroke();
      }
    }
    // stars, planets, Moon
    g.font = "600 12px 'Atkinson Hyperlegible Next', system-ui, sans-serif";
    for (const o of app.objects) {
      const q = proj(o.vec);
      if (!q) continue;
      if (o.kind === "star") {
        const r = Math.max(0.7, 3.2 - o.mag * 0.55);
        if (o.mag < 1.5) { // soft glow on the brightest stars
          const glow = g.createRadialGradient(q[0], q[1], 0, q[0], q[1], r * 4);
          glow.addColorStop(0, starColor(o.star.bv, 0.35)); glow.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = glow; g.beginPath(); g.arc(q[0], q[1], r * 4, 0, 7); g.fill();
        }
        g.fillStyle = starColor(o.star.bv, 1);
        g.beginPath(); g.arc(q[0], q[1], r, 0, 7); g.fill();
        if (o.star.name && o.mag < 1.6) { g.fillStyle = COLORS.label; g.fillText(o.star.name, q[0] + 7, q[1] - 7); }
      } else {
        const r = o.kind === "moon" ? 10 : 4.5;
        g.fillStyle = o.kind === "moon" ? COLORS.moon : COLORS.planet;
        g.beginPath(); g.arc(q[0], q[1], r, 0, 7); g.fill();
        g.fillStyle = COLORS.label; g.fillText(o.name, q[0] + r + 5, q[1] - r - 2);
      }
    }
    // the listening cone: what you can hear right now
    if (app.running) {
      const rr = Math.tan(FOV_HALF * Astro.DEG) * scale;
      const color = app.mode === "find" ? COLORS.ember : COLORS.cone;
      g.strokeStyle = color; g.globalAlpha = 0.9; g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.stroke();
      g.globalAlpha = 0.08; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
      g.lineWidth = 2; g.beginPath();
      g.moveTo(cx - 7, cy); g.lineTo(cx + 7, cy); g.moveTo(cx, cy - 7); g.lineTo(cx, cy + 7); g.stroke();
      // in Find mode, an arrow at the cone's edge points toward the target
      if (app.mode === "find" && app.target) {
        const tv = targetVec();
        const pv = Astro.toView(basis, tv);
        const ang = Math.atan2(-pv[1], pv[0]);
        if (Astro.angleBetween(f, tv) > FOV_HALF) {
          const ax = cx + Math.cos(ang) * (rr + 14), ay = cy + Math.sin(ang) * (rr + 14);
          g.fillStyle = COLORS.ember; g.beginPath();
          g.moveTo(ax + Math.cos(ang) * 10, ay + Math.sin(ang) * 10);
          g.lineTo(ax + Math.cos(ang + 2.4) * 8, ay + Math.sin(ang + 2.4) * 8);
          g.lineTo(ax + Math.cos(ang - 2.4) * 8, ay + Math.sin(ang - 2.4) * 8);
          g.fill();
        }
      }
    }
  }

  function starColor(bv, alpha) {
    const t = Math.min(1, Math.max(0, (bv + 0.3) / 2.1)); // 0 blue-white .. 1 red
    const r = Math.round(185 + 70 * Math.min(1, t * 1.6));
    const gg = Math.round(205 + 35 * (1 - Math.abs(t - 0.35) * 1.4));
    const b = Math.round(255 - 140 * t);
    return `rgba(${r},${gg},${b},${alpha})`;
  }

  function updateStatus(f) {
    updateTopicCard();
    compassCheck();
    const p = Astro.enuToAltAz(f);
    const sensorOk = Sensors.receiving();
    const where = `Aiming ${Math.round(p.alt)}° up, toward the ${Astro.compassWord(p.az)}`;
    const source = Sensors.state.mode === "simulate" ? "Practice mode" : sensorOk ? "" : "Waiting for motion sensors";
    const time = app.timeMode === "tonight" ? "Sky at 9 PM tonight" : "";
    el("status").textContent = [where, source, time].filter(Boolean).join(". ");
    const mode = el("modeText");
    if (mode) {
      const label = app.mode === "find" && app.target ? `Finding ${app.target.label}` : app.tour ? "Tour" : "";
      mode.textContent = label;
      el("modePill").hidden = !label;
    }
  }

  // iPhones report how trustworthy the compass is; warn once if it's poor
  function compassCheck() {
    const acc = Sensors.state.accuracy;
    if (!app.running || app.compassWarned || Sensors.state.mode !== "phone" || acc == null) return;
    if ((acc < 0 || acc > 25) && performance.now() - app.startedAt > 4000) {
      if (Voice.say("Your compass may be off. Wave the phone slowly in a figure eight a few times to calibrate it.", { auto: true })) app.compassWarned = true;
    }
  }

  // before Start, the sky drifts slowly behind the welcome screen
  function idleDrift() {
    if (app.running || reduceMotion) return;
    Sensors.state.raw = Astro.altAzToENU(38, (performance.now() / 1000) * 1.5 % 360);
  }

  // ---------- setup ----------
  function fillTargets() {
    const sel = el("target");
    const add = (group, value, text) => {
      const o = document.createElement("option"); o.value = value; o.textContent = text; group.appendChild(o);
    };
    const g1 = document.createElement("optgroup"); g1.label = "Moon and planets";
    for (const n of ["Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]) add(g1, "object:p" + n, n);
    const g2 = document.createElement("optgroup"); g2.label = "Bright stars";
    S.stars.map((s, i) => ({ s, i })).filter((x) => x.s.name && x.s.mag < 1.8)
      .sort((a, b) => a.s.name.localeCompare(b.s.name))
      .forEach((x) => add(g2, "object:s" + x.i, x.s.name));
    const g3 = document.createElement("optgroup"); g3.label = "Constellations";
    Object.keys(S.lines).map((k) => [k, S.cons[k]]).sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([k, n]) => add(g3, "con:" + k, n));
    sel.append(g1, g2, g3);
  }

  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(false);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          app.loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "your location" };
          resolve(true);
        },
        () => resolve(false),
        { timeout: 8000, maximumAge: 600000 },
      );
    });
  }

  async function keepAwake() {
    try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch (_) {}
  }

  async function start(practice, handsFreeStart = false) {
    Sound.init();
    Voice.unlock(); // iPhones only allow speech that starts inside a tap
    el("startPanel").hidden = true;
    el("controls").hidden = false;
    if (practice) {
      Sensors.startSimulation();
    } else {
      try { await Sensors.startPhone(); }
      catch (e) { Voice.say("Motion access was denied, so I switched to practice mode."); Sensors.startSimulation(); }
    }
    // start playing right away with the default location; refine once GPS answers
    rebuildSky();
    setInterval(rebuildSky, 5000);
    app.running = true;
    app.startedAt = performance.now();
    keepAwake();
    const prefs = Prefs.load();
    const voiceHint = !Listen.supported() ? "" : practice ? "Press the space bar and say help, any time. " :
      "To talk to me, tap anywhere on the screen, then speak. Say help to hear what you can ask. ";
    if (!prefs.welcomed) {
      Prefs.save({ welcomed: true });
      Voice.say("Welcome to StarSound. " + (practice ? "This is practice mode: use the arrow keys or drag the sky to aim. " :
        "Hold your phone up and point it at the sky. Use headphones for 3D sound. ") +
        "Every star in front of you plays a note: brighter is louder, blue is higher, red is lower. " +
        "Sweep slowly, and hold still on a star to hear its name. " + voiceHint +
        "To hear this again, say how does this work.");
    } else {
      Voice.say((practice ? "Practice mode. Arrow keys aim. " : "Point your phone at the sky. ") + voiceHint);
    }
    if (handsFreeStart || Prefs.load().handsFree) {
      setTimeout(() => setHandsFree(true, { quiet: !handsFreeStart }), 600);
    }
    getLocation().then((gotLoc) => {
      if (gotLoc) rebuildSky();
      else Voice.say("I couldn't get your location, so I'm using the sky over Westlake Village.", { interrupt: false });
    });
    if (!practice) {
      setTimeout(() => {
        if (!Sensors.receiving()) {
          Voice.say("I am not getting motion data from this device, so I switched to practice mode.");
          Sensors.startSimulation();
        }
      }, 2500);
    }
  }

  function bind() {
    Voice.attach(el("speech"));
    el("startPhone").onclick = () => start(false);
    el("startPractice").onclick = () => start(true);
    el("startHandsFree").onclick = () => start(false, true);
    el("hereBtn").onclick = whatsHere;
    el("findBtn").onclick = startFind;
    el("conBtn").onclick = () => playConstellation();
    el("tonightBtn").onclick = skyTonight;
    el("calBtn").onclick = calibrate;
    el("pauseBtn").onclick = () => setPaused(!app.paused);
    el("talkBtn").onclick = talk;
    el("tourBtn").onclick = () => (app.tour ? stopAll() : startTour());
    el("nextBtn").onclick = nextStop;
    el("moreBtn").onclick = () => tellMore();
    el("helpBtn").onclick = () => Voice.say(Commands.HELP);
    el("tutorialBtn").onclick = tutorial;
    el("stopBtn").onclick = () => stopAll();
    el("srMode").onchange = (e) => { Voice.setScreenReader(e.target.checked); Prefs.save({ sr: e.target.checked }); };
    el("conNames").onchange = (e) => Prefs.save({ conNames: e.target.checked });
    el("autoNames").onchange = (e) => Prefs.save({ autoNames: e.target.checked });
    el("focus").onchange = (e) => { setFocus(e.target.value); Prefs.save({ focus: e.target.value }); };
    el("detail").onchange = (e) => { setDetail(e.target.value); Prefs.save({ detail: e.target.value }); };
    el("topicMore").onclick = () => runCommand({ action: "describe", ref: "topic" });
    el("topicNear").onclick = nearby;
    el("topicGo").onclick = () => runCommand({ action: "find", ref: "topic" });
    el("journalBtn").onclick = renderJournal;
    document.addEventListener("visibilitychange", () => {
      // phones pause sound when the screen locks or you switch apps; pick back up cleanly
      if (document.visibilityState === "visible" && app.running) { Sound.init(); keepAwake(); rebuildSky(); }
    });
    el("volume").oninput = (e) => { Sound.setVolume(Number(e.target.value)); Prefs.save({ volume: Number(e.target.value) }); };
    el("rate").oninput = (e) => { Voice.setRate(Number(e.target.value)); Prefs.save({ rate: Number(e.target.value) }); };
    el("rate").onchange = () => Voice.say("This is how fast I'll speak.");
    el("decl").onchange = (e) => { Sensors.state.declination = Number(e.target.value) || 0; Prefs.save({ decl: Sensors.state.declination }); };
    el("timeMode").onchange = (e) => { app.timeMode = e.target.value; rebuildSky(); };
    Listen.setHandlers({
      onCommand: (alts, info = { wake: true }) => {
        const cmd = Commands.parseAlternatives(alts);
        // in the hands-free follow-up window, ignore speech that isn't a command (people chatting nearby)
        if (!info.wake && ["unknown", "none", "findUnknown"].includes(cmd.action)) return;
        Sound.earcon("done");
        runCommand(cmd);
      },
      onFollowUp: () => Sound.earcon("ready"),
      onState: onListenState,
      onWake,
    });
    Listen.setSpeakingCheck(() => Voice.speaking());
    Voice.onIdle(() => Listen.speechDone());
    el("handsFreeBtn").onclick = () => setHandsFree(!Listen.handsFree());
    el("logBtn").onclick = () => logSummary("month");
    el("moonBtn").onclick = answerMoonPhase;

    // Eyes-free: while using the phone's sensors, tapping anywhere that isn't a
    // control starts listening, so a blind user never has to find the Talk button.
    document.addEventListener("click", (e) => {
      if (!app.running || Sensors.state.mode !== "phone") return;
      if (e.target.closest("button, select, input, label, summary, details, a, dialog")) return;
      talk();
    });

    // practice mode: keyboard and drag
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      const step = e.shiftKey ? 10 : 3;
      const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (keys[e.key] && Sensors.state.mode === "simulate") { e.preventDefault(); Sensors.nudge(...keys[e.key]); }
      if (e.key === "h") whatsHere();
      if (e.key === "c") playConstellation();
      if (e.key === "t") skyTonight();
      if (e.key === "m") tellMore();
      if (e.key === "n") nextStop();
      if (e.key === " " && app.running) { e.preventDefault(); talk(); }
    });
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || Sensors.state.mode !== "simulate") return;
      Sensors.nudge(-(e.clientX - drag[0]) * 0.15, (e.clientY - drag[1]) * 0.15);
      drag = [e.clientX, e.clientY];
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
  }

  function applyPrefs() {
    const p = Prefs.load();
    if (typeof p.volume === "number") { Sound.setVolume(p.volume); el("volume").value = p.volume; }
    if (typeof p.rate === "number") { Voice.setRate(p.rate); el("rate").value = p.rate; }
    if (typeof p.decl === "number") { Sensors.state.declination = p.decl; el("decl").value = p.decl; }
    if (typeof p.conNames === "boolean") el("conNames").checked = p.conNames;
    if (typeof p.autoNames === "boolean") el("autoNames").checked = p.autoNames;
    if (p.focus) el("focus").value = setFocus(p.focus);
    if (p.detail) { setDetail(p.detail); el("detail").value = p.detail; }
    if (p.sr) { el("srMode").checked = true; Voice.setScreenReader(true); }
  }

  fillTargets();
  bind();
  applyPrefs();
  rebuildSky();
  buildVocabulary();
  requestAnimationFrame(frame);

  // offline support: cache the app so it works at dark-sky sites with no signal
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.StarSound = { app, rebuildSky, describe, skyTonight, whatsHere, playConstellation, runCommand, Log, renderJournal, nearby, describeTarget,
    startTour, nextStop, tellMore, findTarget, resolveRef }; // for testing
})();
