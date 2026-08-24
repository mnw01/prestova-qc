/* Does the standalone file still work with no backend at all? */
const beacon = (q) => fetch("http://localhost:8762/log?" + q, { mode: "no-cors" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const untilTrue = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(200); }
  return false;
};

window.addEventListener("load", async () => {
  try {
    await wait(1500);
    const out = {};
    out.homeRendered = document.querySelectorAll("#modcards .mcard").length;

    location.hash = "#/fqc";
    out.moduleOpens = await untilTrue(() => !document.getElementById("mod").hidden);
    await wait(800);

    // sync must switch itself off and hide the badge when there is no server
    out.syncEnabled = window.__SYNC ? window.__SYNC.enabled : "no-handle";
    out.badgeHidden = document.getElementById("sync").hidden;

    // the form must still save locally
    const el = document.querySelector('[data-f="itemNo"]');
    el.value = "PO-OFFLINE";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(1600);
    out.title = document.title;

    out.savedLocally = await new Promise((res) => {
      const rq = indexedDB.open("prestova-ir", 2);
      rq.onsuccess = () => {
        const t = rq.result.transaction("meta", "readonly").objectStore("meta").getAll();
        t.onsuccess = () => res(t.result.some((m) => m.itemNo === "PO-OFFLINE"));
        t.onerror = () => res("err");
      };
      rq.onerror = () => res("openerr");
    });

    // a photo must still go in
    const c = document.createElement("canvas");
    c.width = 900; c.height = 600;
    c.getContext("2d").fillRect(0, 0, 900, 600);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "off.jpg", { type: "image/jpeg" }));
    const fp = document.getElementById("filepick");
    fp.files = dt.files; fp.dispatchEvent(new Event("change"));
    out.photoWorks = await untilTrue(() => document.querySelectorAll("#grid1 .pimg.has").length >= 1, 20000);

    // and the viewer
    document.querySelector("#grid1 .pimg.has img").click();
    out.lightboxWorks = await untilTrue(() => !document.getElementById("lightbox").hidden, 4000);

    out.protocol = location.protocol;
    beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
  } catch (e) { beacon("THREW=" + encodeURIComponent(e.message)); }
});
