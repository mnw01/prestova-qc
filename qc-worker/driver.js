/* Test driver: injected by the harness only. Phase A writes on "device 1",
   phase B reads on a fresh browser profile = "device 2". */
(function () {
  const beacon = (q) => fetch("http://localhost:8760/log?" + q, { mode: "no-cors" });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const qs = new URLSearchParams(location.search);
  const phase = qs.get("phase");

  // Passcode page → log in, then come back keeping ?phase
  if (document.getElementById("f") && document.getElementById("p")) {
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "test1234" }),
    }).then((r) => {
      if (r.ok) location.replace("/" + location.search);
      else beacon("phase=" + phase + "&FAIL=login-" + r.status);
    });
    return;
  }
  if (!phase) return;

  const untilTrue = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(200); }
    return false;
  };
  const syncText = () => (document.getElementById("sync") || {}).textContent || "";

  window.addEventListener("load", async () => {
    try {
      await wait(1200);
      const out = { phase };

      if (phase === "A") {
        location.hash = "#/fqc";
        await untilTrue(() => !document.getElementById("mod").hidden);
        await wait(600);

        const setF = (name, val) => {
          const el = document.querySelector('[data-f="' + name + '"]');
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        setF("itemNo", "PO-SYNC-1");
        setF("inspector", "TESTER");
        setF("nw", "14.66");
        setF("gw", "15.92");

        // one photo through the real intake path
        const c = document.createElement("canvas");
        c.width = 1200; c.height = 800;
        const x = c.getContext("2d");
        x.fillStyle = "#2f6f3f"; x.fillRect(0, 0, 1200, 800);
        x.fillStyle = "#fff"; x.font = "bold 160px sans-serif";
        x.textAlign = "center"; x.textBaseline = "middle";
        x.fillText("SYNC", 600, 400);
        const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "sync.jpg", { type: "image/jpeg" }));
        const fp = document.getElementById("filepick");
        fp.files = dt.files;
        fp.dispatchEvent(new Event("change"));
        await untilTrue(() => document.querySelectorAll("#grid1 .pimg.has").length >= 1);

        out.badgeSeenPending = await untilTrue(() => /pending|Syncing/.test(syncText()), 8000);
        out.syncedInTime = await untilTrue(() => /^Synced/.test(syncText()), 30000);
        out.badge = syncText();
        out.gwnw = document.querySelector('[data-f="gwnw"]').value;

        // confirm the server really holds it
        const idx = await (await fetch("/api/index", { credentials: "same-origin" })).json();
        const row = (idx.reports || []).find((r) => r.item_no === "PO-SYNC-1");
        out.serverHasReport = !!row;
        out.serverPhotoCount = (idx.photos || []).filter((p) => !p.deleted).length;
        out.serverReportId = row ? row.id : "";
      }

      if (phase === "B") {
        // fresh profile: nothing local, everything must arrive from the server
        out.localAtStart = await new Promise((res) => {
          const rq = indexedDB.open("prestova-ir", 2);
          rq.onsuccess = () => {
            const t = rq.result.transaction("meta", "readonly").objectStore("meta").getAll();
            t.onsuccess = () => res(t.result.length);
            t.onerror = () => res(-1);
          };
          rq.onerror = () => res(-1);
        });

        out.pulled = await untilTrue(
          () => [...document.querySelectorAll("#recentlist .rrow .nm")].some((n) => /PO-SYNC-1/.test(n.textContent)),
          30000
        );
        out.recentText = ([...document.querySelectorAll("#recentlist .rrow .nm")][0] || {}).textContent || "";

        // diagnostics: what does the page actually see?
        out.rrowCount = document.querySelectorAll("#recentlist .rrow").length;
        out.recentHTML = (document.getElementById("recentlist") || {}).textContent || "";
        try {
          const s = window.__SYNC || null;
          out.syncEnabled = s ? s.enabled : "no-handle";
          out.syncErr = s ? String(s.err) : "no-handle";
          out.syncProbed = s ? s.probed : "no-handle";
          out.syncPending = s ? s.pending : "no-handle";
        } catch (e) { out.syncState = "err:" + e.message; }
        try {
          const idx = await (await fetch("/api/index", { credentials: "same-origin" })).json();
          out.pageSeesServerReports = (idx.reports || []).length;
        } catch (e) { out.pageSeesServerReports = "fetch-failed:" + e.message; }
        out.metaRows = await new Promise((res) => {
          const rq = indexedDB.open("prestova-ir", 2);
          rq.onsuccess = () => {
            const t = rq.result.transaction("meta", "readonly").objectStore("meta").getAll();
            t.onsuccess = () => res(JSON.stringify(t.result.map(m => ({ i: m.itemNo, u: m.updatedAt, s: m.syncedAt }))));
            t.onerror = () => res("err");
          };
          rq.onerror = () => res("openerr");
        });

        const row = [...document.querySelectorAll("#recentlist .rrow")]
          .find((b) => /PO-SYNC-1/.test(b.textContent));
        if (row) {
          row.click();
          await untilTrue(() => !document.getElementById("mod").hidden);
          await wait(800);
          out.fieldItemNo = document.querySelector('[data-f="itemNo"]').value;
          out.fieldInspector = document.querySelector('[data-f="inspector"]').value;
          out.fieldGwnw = document.querySelector('[data-f="gwnw"]').value;
          out.photoArrived = await untilTrue(
            () => document.querySelectorAll("#grid1 .pimg.has").length >= 1, 30000);
          const img = document.querySelector("#grid1 .pimg.has img");
          out.photoPixels = img ? img.naturalWidth + "x" + img.naturalHeight : "none";
          out.badge = syncText();
        }
      }

      beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
    } catch (e) {
      beacon("phase=" + phase + "&THREW=" + encodeURIComponent(e.message));
    }
  });
})();
