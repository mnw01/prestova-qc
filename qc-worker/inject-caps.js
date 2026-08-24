/* Dump every page-1 caption with its grid position, so the two edited boxes
   can be confirmed as the ones actually asked for. */
const beacon = (q) => fetch("http://localhost:8766/log?" + q, { mode: "no-cors" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

window.addEventListener("load", async () => {
  try {
    location.hash = "#/fqc";
    let n = 0;
    while (document.getElementById("mod").hidden && n++ < 100) await wait(100);
    await wait(700);

    const slots = [...document.querySelectorAll("#grid1 .slot")];
    const rows = [];
    slots.forEach((s, i) => {
      const cap = s.querySelector("[data-cap]");
      rows.push("r" + (Math.floor(i / 3) + 1) + "c" + ((i % 3) + 1) + "=" + (cap ? cap.value : "?"));
    });
    beacon("count=" + slots.length + "&" + rows.map((r, i) => "p" + i + "=" + encodeURIComponent(r)).join("&"));
  } catch (e) { beacon("THREW=" + encodeURIComponent(e.message)); }
});
