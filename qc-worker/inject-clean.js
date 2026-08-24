/* Blank-report cleanup. The seeds are chosen so that a sloppy "looks empty"
   test would destroy real work: reports whose ONLY content is a photo, or a
   caption, or a defect flag, and old reports that only carry the auto-filled
   inspection date (those must go). */
const beacon = (q) => fetch("http://localhost:8774/log?" + q, { mode: "no-cors" });
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
const OLD = Date.now() - 2 * DAY;
const NEW = Date.now() - 60000;

function rec(id, ts, over) {
  return Object.assign({
    id, type: "fqc", updatedAt: ts, syncedAt: 0,
    fields: { inspDate: "29/07/2026" },      // auto-filled, must NOT count as content
    checks: { verdict: "accept" },           // auto-default, must NOT count as content
    caps: {}, flags: {}, fits: {}, photos: {}, photoOps: {}, serverPhotos: {}, tol: "1.5",
  }, over || {});
}

function seed() {
  const blob = new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" });
  const recs = [
    rec("c-old-blank1", OLD),                                     // DELETE
    rec("c-old-blank2", OLD - 1000),                              // DELETE
    rec("c-new-blank",  NEW),                                     // keep: too fresh
    rec("c-old-itemno", OLD, { fields: { inspDate: "x", itemNo: "PO-KEEP" } }), // keep
    rec("c-old-photo",  OLD, { photos: { packing: blob } }),       // keep: has a photo
    rec("c-old-caption",OLD, { caps: { other1: "MY LABEL" } }),    // keep: edited caption
    rec("c-old-flag",   OLD, { flags: { moisture: true } }),       // keep: defect flag
    rec("c-old-fit",    OLD, { fits: { packing: "cover" } }),      // keep: fit toggle
    rec("c-old-result", OLD, { fields: { inspDate: "x", testResult: "rework needed" } }), // keep
  ];
  return new Promise((res) => {
    const rq = indexedDB.open("prestova-ir", 2);
    rq.onsuccess = () => {
      const t = rq.result.transaction(["reports", "meta"], "readwrite");
      recs.forEach((r) => {
        t.objectStore("reports").put(r);
        t.objectStore("meta").put({ id: r.id, type: "fqc", updatedAt: r.updatedAt,
          itemNo: (r.fields.itemNo || ""), po: "", syncedAt: r.syncedAt,
          photoPending: Object.keys(r.photoOps || {}).length });
      });
      t.oncomplete = () => res(recs.length);
      t.onerror = () => res(-1);
    };
    rq.onerror = () => res(-1);
  });
}

const idsInDb = () => new Promise((res) => {
  const rq = indexedDB.open("prestova-ir", 2);
  rq.onsuccess = () => {
    const t = rq.result.transaction("meta", "readonly").objectStore("meta").getAll();
    t.onsuccess = () => res(t.result.map((m) => m.id).filter((i) => i.indexOf("c-") === 0).sort());
    t.onerror = () => res(["err"]);
  };
  rq.onerror = () => res(["openerr"]);
});

window.addEventListener("load", async () => {
  try {
    const out = {};
    out.seeded = await seed();
    out.before = (await idsInDb()).join(",");

    // cleanup runs during boot, so reload with the seeds already in place
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      location.reload();
      return;
    }

    await untilTrue(async () => {
      const ids = await idsInDb();
      return ids.indexOf("c-old-blank1") < 0;
    }, 30000);
    await wait(1200);

    const after = await idsInDb();
    out.after = after.join(",");
    out.deletedBlank1 = after.indexOf("c-old-blank1") < 0;
    out.deletedBlank2 = after.indexOf("c-old-blank2") < 0;
    out.keptFresh     = after.indexOf("c-new-blank") >= 0;
    out.keptItemNo    = after.indexOf("c-old-itemno") >= 0;
    out.keptPhoto     = after.indexOf("c-old-photo") >= 0;
    out.keptCaption   = after.indexOf("c-old-caption") >= 0;
    out.keptFlag      = after.indexOf("c-old-flag") >= 0;
    out.keptFit       = after.indexOf("c-old-fit") >= 0;
    out.keptResult    = after.indexOf("c-old-result") >= 0;

    beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
  } catch (e) { beacon("THREW=" + encodeURIComponent(e.message)); }
});
