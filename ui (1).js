// ui.js — the screen's sheets (Find, More, Settings). The app logic lives in app.js;
// this file only opens and closes panels and builds the searchable Find list.

(() => {
  const $ = (id) => document.getElementById(id);
  const S = window.SKY_DATA;

  function open(id) {
    const d = $(id);
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function close(d) { if (d.close) d.close(); else d.removeAttribute("open"); }

  document.querySelectorAll("dialog").forEach((d) => {
    d.querySelectorAll("[data-close], [data-closes]").forEach((b) => b.addEventListener("click", () => close(d)));
    d.addEventListener("click", (e) => { if (e.target === d) close(d); }); // tap outside the sheet
    // when a sheet closes, put focus back on the full-screen Talk button, so VoiceOver users
    // can always double-tap anywhere to talk
    d.addEventListener("close", () => setTimeout(() => {
      if (!document.querySelector("dialog[open]") && !$("controls").hidden) $("talkBtn").focus();
    }, 50));
  });

  // Menu buttons that repeat a shortcut ("What's here?", "Tonight", "Find") press the real one
  document.querySelectorAll("[data-proxy]").forEach((b) => b.addEventListener("click", () => {
    setTimeout(() => $(b.dataset.proxy).click(), 60);
  }));
  $("openMenu").addEventListener("click", () => open("menuSheet"));
  $("menuSettings").addEventListener("click", () => setTimeout(() => open("settingsSheet"), 60));

  $("openSettings").addEventListener("click", () => { close($("moreSheet")); open("settingsSheet"); });
  $("openMore").addEventListener("click", () => setTimeout(() => open("moreSheet"), 60));
  $("privacyBtn").addEventListener("click", () => { close($("moreSheet")); open("privacySheet"); });
  $("journalBtn").addEventListener("click", () => { close($("moreSheet")); open("journalSheet"); });
  $("clearLogBtn").addEventListener("click", () => {
    if (!confirm("Erase everything in your observing log?")) return;
    if (window.StarSound) StarSound.Log.clear();
    Voice.say("Your observing log is erased.");
  });
  $("openFind").addEventListener("click", () => {
    $("findSearch").value = "";
    renderFind("");
    open("findSheet");
  });

  // after Start, put keyboard and screen-reader focus on the Talk button
  ["startPhone", "startPractice"].forEach((id) =>
    $(id).addEventListener("click", () => setTimeout(() => { if (!document.querySelector("dialog[open]")) $("talkBtn").focus(); }, 300)));

  window.StarSoundUI = { open, close, openMenu: () => open("menuSheet"), openSettings: () => { document.querySelectorAll("dialog[open]").forEach(close); open("settingsSheet"); }, closeAll: () => document.querySelectorAll("dialog[open]").forEach(close) };

  // ---------- Find list ----------
  // Stars that never rise from the user's location are left out, and each item says
  // whether it's up now (and where) or when it rises, with what's up now listed first.
  const items = [];
  const planetNotes = { Moon: "our Moon", Mercury: "planet", Venus: "planet", Mars: "planet", Jupiter: "planet", Saturn: "planet" };
  for (const n of Object.keys(planetNotes)) items.push({ group: "Moon and planets", value: "object:p" + n, label: n === "Moon" ? "The Moon" : n, target: { type: "object", id: "p" + n }, note: planetNotes[n] });
  S.stars.forEach((s, i) => {
    if (s.name && s.mag < 2.6) items.push({ group: "Bright stars", value: "object:s" + i, label: s.name, dec: s.dec, target: { type: "object", id: "s" + i }, note: s.con ? S.cons[s.con] : "" });
  });
  for (const id of Object.keys(S.lines)) {
    const dec = Math.max(...[...new Set(S.lines[id].flat())].map((i) => S.stars[i].dec)); // its most northern star
    items.push({ group: "Constellations", value: "con:" + id, label: S.cons[id], dec, target: { type: "con", id }, note: "" });
  }
  const order = { "Moon and planets": 0, "Bright stars": 1, Constellations: 2 };

  function status(it) {
    const SS = window.StarSound;
    if (!SS) return { up: false, text: "" };
    const v = SS.targetVec(it.target);
    const { alt, az } = Astro.enuToAltAz(v);
    if (alt > 0) return { up: true, text: `Up now, ${Astro.compassWord(az)}` };
    const rise = SS.nextRiseSet(it.target, "rise");
    return { up: false, text: rise ? `Rises ${rise.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not up today" };
  }

  function renderFind(q) {
    const box = $("findList");
    box.textContent = "";
    const query = q.trim().toLowerCase();
    const lat = window.StarSound ? StarSound.app.loc.lat : 34;
    const shown = items
      .filter((it) => it.dec === undefined || it.dec > lat - 90) // never rises here
      .filter((it) => !query || it.label.toLowerCase().includes(query) || it.note.toLowerCase().includes(query))
      .map((it) => ({ ...it, st: status(it) }))
      .sort((a, b) => order[a.group] - order[b.group] || (b.st.up - a.st.up) ||
        (a.group === "Moon and planets" ? 0 : a.label.localeCompare(b.label)));
    if (!shown.length) {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = "Nothing by that name in your sky. Try a planet, a bright star, or a constellation.";
      box.appendChild(p); return;
    }
    let group = null, list = null;
    for (const it of shown) {
      if (it.group !== group) {
        group = it.group;
        const h = document.createElement("h3"); h.className = "group-title"; h.textContent = group;
        list = document.createElement("ul"); list.className = "list";
        box.append(h, list);
      }
      const li = document.createElement("li");
      const b = document.createElement("button");
      const name = document.createElement("span"); name.textContent = it.label;
      const hint = document.createElement("span"); hint.className = "hint" + (it.st.up ? " up" : "");
      hint.textContent = it.st.text || it.note;
      const pause = document.createElement("span"); pause.className = "visually-hidden"; pause.textContent = ". ";
      b.append(name, pause, hint); // screen readers hear "Saturn. Up now, southeast"
      b.addEventListener("click", () => {
        const sel = $("target");
        let opt = [...sel.options].find((o) => o.value === it.value);
        if (!opt) { opt = new Option(it.label, it.value); sel.add(opt); }
        sel.value = it.value;
        opt.textContent = it.label === "The Moon" ? "the Moon" : it.label;
        close($("findSheet"));
        if (window.StarSound && StarSound.app.mode === "find") $("findBtn").click(); // stop the previous search first
        $("findBtn").click();
      });
      li.appendChild(b);
      list.appendChild(li);
    }
  }
  $("findSearch").addEventListener("input", (e) => renderFind(e.target.value));
})();
