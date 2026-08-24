/* Caption isolation: an edit must stick to its own container, a new container
   must show the factory default, and switching back must restore the edit. */
const beacon = (q) => fetch("http://localhost:8768/log?" + q, { mode: "no-cors" });
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

const capOf = (slot) => {
  const s = document.querySelector('.slot[data-slot="' + slot + '"] [data-cap]');
  return s ? s.value : "?";
};
const setF = (name, val) => {
  const el = document.querySelector('[data-f="' + name + '"]');
  el.value = val; el.dispatchEvent(new Event("input", { bubbles: true }));
};

window.addEventListener("load", async () => {
  try {
    location.hash = "#/fqc";
    await untilTrue(() => !document.getElementById("mod").hidden);
    await wait(900);
    const out = {};

    // ---- container A: give it an identity, then edit one caption
    setF("itemNo", "CAP-A");
    await wait(400);
    out.defaultBefore = capOf("other1");

    const capEl = document.querySelector('.slot[data-slot="other1"] [data-cap]');
    capEl.value = "CUSTOM-FOR-A";
    capEl.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(1500);
    out.aAfterEdit = capOf("other1");
    const idA = document.getElementById("pick").value;

    // also edit a second slot to be sure it is not a one-off
    const cap2 = document.querySelector('.slot[data-slot="technical"] [data-cap]');
    cap2.value = "A-SLOT-12";
    cap2.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(1500);

    // ---- new container B
    document.getElementById("new").click();
    await wait(2200);
    setF("itemNo", "CAP-B");
    await wait(1200);
    const idB = document.getElementById("pick").value;
    out.newIsDifferentReport = idA !== idB;
    out.bCaption_other1 = capOf("other1");
    out.bCaption_technical = capOf("technical");

    // B must not have inherited A's text, and must not have stored anything
    out.bStoredCaps = await new Promise((res) => {
      const rq = indexedDB.open("prestova-ir", 2);
      rq.onsuccess = () => {
        const t = rq.result.transaction("reports", "readonly").objectStore("reports").get(idB);
        t.onsuccess = () => res(t.result ? JSON.stringify(t.result.caps || {}) : "no-record");
        t.onerror = () => res("err");
      };
      rq.onerror = () => res("openerr");
    });

    // ---- switch back to A
    const sel = document.getElementById("pick");
    sel.value = idA;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await untilTrue(() => capOf("other1") === "CUSTOM-FOR-A", 8000);
    await wait(500);
    out.backToA_other1 = capOf("other1");
    out.backToA_technical = capOf("technical");
    out.backToA_itemNo = document.querySelector('[data-f="itemNo"]').value;

    // ---- and back to B once more
    sel.value = idB;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(1500);
    out.bAgain_other1 = capOf("other1");
    out.bAgain_itemNo = document.querySelector('[data-f="itemNo"]').value;

    beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
  } catch (e) { beacon("THREW=" + encodeURIComponent(e.message)); }
});
