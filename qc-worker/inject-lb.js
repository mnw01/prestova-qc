/* Lightbox test: fill three slots, then exercise open / browse / zoom / close. */
const beacon = (q) => fetch("http://localhost:8760/log?" + q, { mode: "no-cors" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* the harness injects this into the passcode page too — log in, then reload */
if (document.getElementById("f") && document.getElementById("p")) {
  fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "test1234" }),
  }).then((r) => { if (r.ok) location.replace("/" + location.search);
                   else beacon("FAIL=login-" + r.status); });
  throw new Error("gate page — stop here");
}
const untilTrue = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(150); }
  return false;
};
const lb = () => document.getElementById("lightbox");
const shown = () => !lb().hidden;

function makeImg(w, h, label) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d");
  x.fillStyle = "#39506b"; x.fillRect(0, 0, w, h);
  x.fillStyle = "#fff"; x.font = "bold " + Math.round(Math.min(w, h) / 4) + "px sans-serif";
  x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(label, w / 2, h / 2);
  return new Promise((r) => c.toBlob((b) => r(new File([b], label + ".jpg", { type: "image/jpeg" })), "image/jpeg", 0.9));
}

window.addEventListener("load", async () => {
  try {
    location.hash = "#/fqc";
    await untilTrue(() => !document.getElementById("mod").hidden);
    await wait(900);
    const out = {};

    const files = [await makeImg(1400, 900, "ONE"), await makeImg(900, 1400, "TWO"), await makeImg(1000, 1000, "THREE")];
    const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
    const fp = document.getElementById("filepick");
    fp.files = dt.files; fp.dispatchEvent(new Event("change"));
    await untilTrue(() => document.querySelectorAll("#grid1 .pimg.has").length >= 3, 40000);
    await wait(600);
    out.filled = document.querySelectorAll("#grid1 .pimg.has").length;
    out.hiddenBefore = !shown();

    // clicking a corner button must NOT open the viewer
    const firstSlot = document.querySelector("#grid1 .slot .pimg.has").closest(".slot");
    firstSlot.querySelector(".pfit").click();
    await wait(250);
    out.fitButtonDidNotOpen = !shown();
    firstSlot.querySelector(".pfit").click(); // restore
    await wait(200);

    // clicking the photo opens it
    firstSlot.querySelector(".pimg.has img").click();
    out.opensOnPhotoClick = await untilTrue(shown, 4000);
    await wait(400);
    out.cap1 = document.getElementById("lb-cap").textContent;
    out.count1 = document.getElementById("lb-count").textContent;
    out.imgLoaded = document.getElementById("lb-img").naturalWidth + "x" + document.getElementById("lb-img").naturalHeight;
    out.prevDisabledAtStart = document.getElementById("lb-prev").disabled;

    // browse
    document.getElementById("lb-next").click(); await wait(350);
    out.count2 = document.getElementById("lb-count").textContent;
    out.cap2 = document.getElementById("lb-cap").textContent;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); await wait(350);
    out.count3 = document.getElementById("lb-count").textContent;
    out.nextDisabledAtEnd = document.getElementById("lb-next").disabled;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); await wait(350);
    out.countAfterLeft = document.getElementById("lb-count").textContent;

    // actual-size toggle
    document.getElementById("lb-img").click(); await wait(250);
    out.actualOn = document.getElementById("lb-stage").classList.contains("actual");
    document.getElementById("lb-img").click(); await wait(250);
    out.actualOff = !document.getElementById("lb-stage").classList.contains("actual");

    // Esc closes
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    out.escCloses = await untilTrue(() => !shown(), 3000);

    // backdrop closes
    firstSlot.querySelector(".pimg.has img").click();
    await untilTrue(shown, 4000); await wait(300);
    document.getElementById("lb-stage").click();
    out.backdropCloses = await untilTrue(() => !shown(), 3000);

    // page-2 photo also opens
    const p2 = document.querySelector("#grid2 .slot");
    out.page2SlotExists = !!p2;

    beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
  } catch (e) {
    beacon("THREW=" + encodeURIComponent(e.message));
  }
});
