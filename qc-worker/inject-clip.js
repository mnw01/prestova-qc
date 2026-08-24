/* Is anything lost to the sheet's overflow:hidden at the new height? */
const beacon = (q) => fetch("http://localhost:8764/log?" + q, { mode: "no-cors" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

window.addEventListener("load", async () => {
  try {
    location.hash = "#/fqc";
    let n = 0;
    while (document.getElementById("mod").hidden && n++ < 100) await wait(100);
    document.querySelector(".wrap").style.cssText =
      "width:192mm;padding:0;display:block;background:#fff;margin:0 auto";
    await wait(900);

    const mm = (v) => +(v / 96 * 25.4).toFixed(1);
    const out = {};
    ["s1", "s2"].forEach((id) => {
      const sh = document.getElementById(id), r = sh.getBoundingClientRect();
      out[id + "H"] = mm(r.height);
      let over = 0, who = "";
      sh.querySelectorAll("*").forEach((e) => {
        const b = e.getBoundingClientRect();
        if (b.height > 0 && b.bottom > r.bottom + 1) {
          const o = b.bottom - r.bottom;
          if (o > over) { over = o; who = e.tagName.toLowerCase() + "." + ((e.className || "") + "").split(" ")[0]; }
        }
      });
      out[id + "ClippedMM"] = mm(over);
      out[id + "ClipWho"] = who || "none";
    });
    out.photoFrame = mm(document.querySelector("#grid1 .pimg").getBoundingClientRect().height);
    beacon(Object.keys(out).map((k) => k + "=" + encodeURIComponent(out[k])).join("&"));
  } catch (e) { beacon("THREW=" + encodeURIComponent(e.message)); }
});
