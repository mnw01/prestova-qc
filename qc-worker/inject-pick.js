/* Report picker: day grouping, collapse/expand, counts, switching. Seeds
   records dated across three days straight into IndexedDB so grouping is real. */
const beacon = (q) => fetch("http://localhost:8770/log?" + q, { mode: "no-cors" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const untilTrue = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(150); }
  return false;
};

if (document.getElementById("f") && document.getElementById("p")) {
  fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "test1234" }) })
    .then((r) => { if (r.ok) location.replace("/" + location.search); else beacon("FAIL=login"); });
  throw new Error("gate");
}

const DAY = 86400000;
function seed() {
  // 3 today, 2 yesterday, 1 the day before — all already "synced" so no pushes
  const now = Date.now();
  const recs = [
    ["S-T1", now - 1000], ["S-T2", now - 2000], ["S-T3", now - 3000],
    ["S-Y1", now - DAY], ["S-Y2", now - DAY - 5000],
    ["S-D1", now - 2 * DAY],
  ];
  return new Promise((res) => {
    const rq = indexedDB.open("prestova-ir", 2);
    rq.onsuccess = () => {
      const db = rq.result;
      const t = db.transaction(["reports", "meta"], "readwrite");
      recs.forEach(([name, ts], i) => {
        const rec = { id: "seed-" + i, type: "fqc", updatedAt: ts, syncedAt: ts,
          fields: { itemNo: name }, checks: {}, caps: {}, flags: {}, fits: {},
          photos: {}, photoOps: {}, serverPhotos: {}, tol: "1.5" };
        t.objectStore("reports").put(rec);
        t.objectStore("meta").put({ id: rec.id, type: "fqc", updatedAt: ts,
          itemNo: name, po: "", syncedAt: ts, photoPending: 0 });
      });
      t.oncomplete = () => res(recs.length);
      t.onerror = () => res(-1);
    };
    rq.onerror = () => res(-1);
  });
}

window.addEventListener("load", async () => {
  try {
    await wait(900);
    const out = {};
    out.seeded = await seed();

    location.hash = "#/fqc";
    await untilTrue(() => !document.getElementById("mod").hidden);
    await wait(1200);
    location.reload = location.reload; // no-op, keep linters quiet

    // force the picker to re-read storage
    document.getElementById("pickbtn").click();
    await untilTrue(() => !document.getElementById("picklist").hidden, 5000);
    await wait(500);

    const days = () => [...document.querySelectorAll("#plbody .plday")];
    const rows = () => [...document.querySelectorAll("#plbody .plrow")];

    out.dayGroups = days().length;
    out.dayHeaders = days().map(d => d.querySelector(".pldate").textContent + ":" + d.querySelector(".pln").textContent).join(" | ");
    out.totalCount = document.getElementById("plcount").textContent;
    out.rowsVisibleInitially = rows().length;
    out.firstDayExpanded = days()[0].querySelector(".plarrow").textContent === "▾";
    out.olderDaysCollapsed = days().slice(1).every(d => d.querySelector(".plarrow").textContent === "▸");

    // expand the second day
    days()[1].click();
    await wait(400);
    out.afterExpandSecond_rows = rows().length;
    out.secondNowOpen = days()[1].querySelector(".plarrow").textContent === "▾";

    // collapse the first day
    days()[0].click();
    await wait(400);
    out.afterCollapseFirst_rows = rows().length;
    out.firstNowClosed = days()[0].querySelector(".plarrow").textContent === "▸";

    // pick a report from the (still open) second day
    const target = rows()[0];
    out.pickedLabel = target.querySelector(".plnm").textContent;
    target.click();
    await untilTrue(() => document.getElementById("picklist").hidden, 4000);
    await wait(1200);
    out.loadedItemNo = document.querySelector('[data-f="itemNo"]').value;
    out.buttonLabel = document.getElementById("picklabel").textContent;
    out.labelMatchesLoaded = out.buttonLabel.indexOf(out.loadedItemNo) === 0;

    // reopen: the day holding the current report must be expanded, and marked
    document.getElementById("pickbtn").click();
    await untilTrue(() => !document.getElementById("picklist").hidden, 4000);
    await wait(400);
    out.currentRowMarked = !!document.querySelector("#plbody .plrow.cur");
    out.currentRowText = (document.querySelector("#plbody .plrow.cur .plnm") || {}).textContent || "";

    // Esc closes
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    out.escCloses = await untilTrue(() => document.getElementById("picklist").hidden, 3000);

    beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
  } catch (e) { beacon("THREW=" + encodeURIComponent(e.message)); }
});
