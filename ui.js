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
  });

  $("openSettings").addEventListener("click", () => open("settingsSheet"));
  $("openMore").addEventListener("click", () => open("moreSheet"));
  $("privacyBtn").addEventListener("click", () => { close($("moreSheet")); open("privacySheet"); });
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
  ["startPhone", "startHandsFree", "startPractice"].forEach((id) =>
    $(id).addEventListener("click", () => {
      $("openSettings").hidden = false;
      setTimeout(() => $("talkBtn").focus(), 300);
    }));

  // ---------- Find list ----------
  const items = [];
  const planetNotes = { Moon: "our Moon", Mercury: "planet", Venus: "planet", Mars: "planet", Jupiter: "planet", Saturn: "planet" };
  for (const n of Object.keys(planetNotes)) items.push({ group: "Moon and planets", value: "object:p" + n, label: n === "Moon" ? "The Moon" : n, hint: planetNotes[n] });
  S.stars.forEach((s, i) => {
    if (s.name && s.mag < 2.6) items.push({ group: "Bright stars", value: "object:s" + i, label: s.name, hint: s.con ? S.cons[s.con] : "" });
  });
  for (const id of Object.keys(S.lines)) items.push({ group: "Constellations", value: "con:" + id, label: S.cons[id], hint: "" });
  const order = { "Moon and planets": 0, "Bright stars": 1, Constellations: 2 };
  items.sort((a, b) => order[a.group] - order[b.group] || (a.group === "Moon and planets" ? 0 : a.label.localeCompare(b.label)));

  function renderFind(q) {
    const box = $("findList");
    box.textContent = "";
    const query = q.trim().toLowerCase();
    const shown = items.filter((it) => !query || it.label.toLowerCase().includes(query) || it.hint.toLowerCase().includes(query));
    if (!shown.length) {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = "Nothing by that name in StarSound's sky. Try a planet, a bright star, or a constellation.";
      box.appendChild(p); return;
    }
    let group = null, list = null;
    for (const it of shown) {
      if (it.group !== group) {
        group = it.group;
        const h = document.createElement("h3"); h.className = "group-title"; h.textContent = group;
        list = document.createElement("div"); list.className = "list"; list.setAttribute("role", "list");
        box.append(h, list);
      }
      const b = document.createElement("button");
      b.setAttribute("role", "listitem");
      const name = document.createElement("span"); name.textContent = it.label;
      const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = it.hint;
      b.append(name, hint);
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
      list.appendChild(b);
    }
  }
  $("findSearch").addEventListener("input", (e) => renderFind(e.target.value));
})();
