/* 生成只用于验证的页面副本：在最外层 IIFE 结束前插一段引导代码
   （外层是 IIFE，从外面够不着内部函数），页面自己跑完后把 document.title
   改成 DEMO:ready，由 cdpshot.js 等这个信号再截图 / 打印。

   用法: node mkdemo.js <dash|report|home> [输出文件名]
   dash   进实验室 → 用真实的「导入历史」按钮灌 7 个月数据 → 打开看板
   report 进实验室 → 填一批 → 出检验报告（构建打印用 DOM，不弹打印框）
   home   只回首页，用来看模块卡片有没有被样式串掉
*/
const fs = require('fs');
const DIR = 'H:/我的云端硬盘/开发/荣升检查报告/';
const mode = process.argv[2] || 'dash';
const outFile = process.argv[3] || ('demo-' + mode + '.html');
const src = fs.readFileSync(DIR + 'index.html', 'utf8');

const HIST = ['dash','rec','views','pick','range','export'].includes(mode)
  ? JSON.stringify(fs.readFileSync(DIR + '参考资料/实验室历史数据-2026.json', 'utf8'))
  : '""';
/* xlsx 模式：把真实的表当 base64 内联进去，走真实的「导入旧记录表」按钮 */
const XLSB64 = ['xlsx','sync'].includes(mode)
  ? JSON.stringify(fs.readFileSync(DIR + '参考资料/实验室检测记录表2026-快照.xlsx').toString('base64'))
  : '""';

const demo = `
/* ── demo bootstrap（仅测试副本，不在发布版里） ── */
(function(){
  const MODE = ${JSON.stringify(mode)};
  const HIST = ${HIST};
  const XLSB64 = ${XLSB64};
  const wait = ms => new Promise(r=>setTimeout(r,ms));
  const $$ = s => document.querySelector(s);
  const fire = (el,v) => { el.value=v; el.dispatchEvent(new Event("input",{bubbles:true})); };
  const pick = (el,v) => { el.value=v; el.dispatchEvent(new Event("change",{bubbles:true})); };
  window.confirm = () => true;
  window.print = () => {};                      /* 别真弹打印框 */

  (async ()=>{
    if (MODE === "home"){
      location.hash = "#/"; await wait(1500);
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "fqc"){                       /* 回归：成品检验还是不是两页 */
      location.hash = "#/fqc"; await wait(1800);
      fire(document.querySelector('[data-f="itemNo"]'), "PO-9001");
      fire(document.querySelector('[data-f="po"]'), "INV-77");
      await wait(900);
      document.title = "DEMO:ready"; return;
    }

    location.hash = "#/lab"; await wait(1500);

    /* 灌历史数据，rec / views / dash 共用 */
    const loadHist = async () => {
      const inp = $$("#histpick");
      const dt = new DataTransfer();
      dt.items.add(new File([HIST], "h.json", {type:"application/json"}));
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change",{bubbles:true}));
      for (let i=0;i<120;i++){
        await wait(500);
        const rows = await metaAll().catch(()=>[]);
        if (rows.filter(r=>r.type==="lab").length >= 1230) break;
      }
      await wait(800);
    };

    if (MODE === "pick"){
      await loadHist();
      $$("#lpickbtn").click(); await wait(900);
      const labDays = [...document.querySelectorAll("#lplbody .plday")]
        .slice(0,4).map(n=>n.textContent.replace(/[▾▸]/g,"").trim());
      const labOpenRows = document.querySelectorAll("#lplbody .plrow").length;
      /* 折叠/展开 */
      document.querySelector("#lplbody .plday").click(); await wait(400);
      const afterCollapse = document.querySelectorAll("#lplbody .plrow").length;
      $$("#lpl-close").click(); await wait(300);
      /* 成品检验那边 */
      location.hash = "#/fqc"; await wait(1500);
      fire(document.querySelector('[data-f="itemNo"]'), "PO-9001"); await wait(900);
      $$("#pickbtn").click(); await wait(600);
      const fqcDays = [...document.querySelectorAll("#plbody .plday")]
        .map(n=>n.textContent.replace(/[▾▸]/g,"").trim());
      window.__VIEWLOG = [["实验室日期分组(前4)", labDays],
                          ["展开时批次行数", labOpenRows],
                          ["折叠首组后行数", afterCollapse],
                          ["成品检验日期分组", fqcDays]];
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "sync"){     /* 导入后能不能真的同步上去（配 serve-test.mjs） */
      const bin = atob(XLSB64);
      const u8 = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
      $$("#lsheetbtn").click(); await wait(1200);
      const inp = $$("#histpick");
      const dt = new DataTransfer();
      dt.items.add(new File([u8], "记录表.xlsx",
        {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change",{bubbles:true}));
      let local = 0;
      for (let i=0;i<240;i++){
        await wait(500);
        local = (await metaAll().catch(()=>[])).filter(r=>r.type==="lab").length;
        if (local >= 1230) break;
      }
      /* 等同步把它们推上去 */
      const t0 = Date.now();
      let stat = {};
      for (let i=0;i<300;i++){
        await wait(1000);
        stat = await (await fetch("/__stat")).json();
        const lab = (stat.rows||[]).find(r=>r.type==="lab");
        if (lab && lab.n >= 1230) break;
        if (window.__SYNC && window.__SYNC.err) break;
      }
      const idx = await (await fetch("/api/index")).json();
      window.__VIEWLOG = [{
        本地批数: local,
        服务端收到: stat.rows,
        PUT次数: stat.puts, PUT失败: stat.bad,
        同步耗时秒: ((Date.now()-t0)/1000).toFixed(1),
        SYNC状态: window.__SYNC && {err:window.__SYNC.err, stuck:window.__SYNC.stuck,
                                    pending:window.__SYNC.pending},
        服务端索引条数: (idx.rows||idx||[]).length,
      }];
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "xlsx"){     /* 直接喂真实 xlsx，和 Python 转出来的结果对比 */
      const bin = atob(XLSB64);
      const u8 = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
      $$("#lsheetbtn").click(); await wait(1200);
      const inp = $$("#histpick");
      const dt = new DataTransfer();
      dt.items.add(new File([u8], "实验室检测记录表2026.xlsx",
        {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
      inp.files = dt.files;
      const t0 = Date.now();
      inp.dispatchEvent(new Event("change",{bubbles:true}));
      let n = 0;
      for (let i=0;i<240;i++){
        await wait(500);
        n = (await metaAll().catch(()=>[])).filter(r=>r.type==="lab").length;
        if (n >= 1230) break;
      }
      const secs = ((Date.now()-t0)/1000).toFixed(1);
      await wait(1000);
      $$("#ldashbtn").click(); await wait(2500);
      pick($$("#ld-range"),"all"); await wait(1200);
      window.__VIEWLOG = [{
        导入批数: n, 耗时秒: secs,
        KPI: [...document.querySelectorAll("#ld-kpis .lkpi")]
               .map(x=>x.innerText.split(String.fromCharCode(10)).join(" ")).join(" | "),
        说明: $$("#ld-scope").textContent,
        品号数: $$("#ld-model").options.length - 1,
      }];
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "range"){          /* 看板区间筛选是否真的生效 */
      await loadHist();
      $$("#ldashbtn").click(); await wait(2500);
      const log = [];
      for (const v of ["cur","1","3","6","12","all"]){
        pick($$("#ld-range"), v); await wait(900);
        log.push({ 选项: $$("#ld-range").selectedOptions[0].textContent,
                   KPI: [...document.querySelectorAll("#ld-kpis .lkpi")]
                          .map(n=>n.innerText.split(String.fromCharCode(10)).join(" ")).join(" | "),
                   月份条数: document.querySelectorAll("#ld-months .lbar").length,
                   说明: $$("#ld-scope").textContent });
      }
      /* 再按品号筛一次 */
      pick($$("#ld-range"),"all"); await wait(500);
      pick($$("#ld-model"),"F2030"); await wait(900);
      log.push({ 选项:"全部 + 品号 F2030",
                 KPI:[...document.querySelectorAll("#ld-kpis .lkpi")]
                       .map(n=>n.innerText.split(String.fromCharCode(10)).join(" ")).join(" | "),
                 月份条数: document.querySelectorAll("#ld-months .lbar").length,
                 说明: $$("#ld-scope").textContent });
      window.__VIEWLOG = log;
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "batch"){          /* 只看批号那一行的排布 */
      pick($$("#lmodel"),"F2450-A"); await wait(200);
      pick($("#lbt-ymd"),"2026-08-01"); pick($("#lbt-seq"),"05"); pick($("#lbt-line"),"A01");
      await wait(700); window.scrollTo(0,0);
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "rec"){
      await loadHist();
      $$("#lsheetbtn").click(); await wait(1500);
      pick($$("#lrec-date"), "2026-07-30"); await wait(600);
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "export"){   /* 导出是否跟着记录表当前筛选走 */
      await loadHist();
      $$("#lsheetbtn").click(); await wait(1500);
      pick($$("#lrec-date"), "2026-07-30"); await wait(500);
      const grab = async () => {
        let blob = null, name = "";
        const OU = URL.createObjectURL; URL.createObjectURL = b => { blob = b; return "blob:s"; };
        const oc = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(){ name = this.download; };
        $$("#lcsv").click(); await wait(1000);
        URL.createObjectURL = OU; HTMLAnchorElement.prototype.click = oc;
        const t = blob ? await blob.text() : "";
        return { 文件名:name, 数据行:Math.max(0, t.split(String.fromCharCode(13,10)).length-1),
                 表上显示:$$("#lrec-scope").textContent };
      };
      const log = [];
      for (const v of ["day","month","1","3","all"]){
        pick($$("#lrec-range"), v); await wait(700);
        log.push(Object.assign({选项:$$("#lrec-range").selectedOptions[0].textContent}, await grab()));
      }
      pick($$("#lrec-range"),"1"); await wait(400);
      pick($$("#lrec-model"),"F2030"); await wait(700);
      log.push(Object.assign({选项:"近1个月 + F2030"}, await grab()));
      window.__VIEWLOG = log;
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "views"){
      await loadHist();
      const vis = () => ({
        entry: !document.querySelector("#lab .lwrap").hidden,
        sheet: !$$("#lsheetv").hidden, dash: !$$("#ldash").hidden, std: !$$("#lstd").hidden,
        cur: [...document.querySelectorAll("#lab .bar button.cur")].map(b=>b.textContent),
      });
      const log = [];
      log.push(["初始", vis()]);
      $$("#ldashbtn").click(); await wait(2500); log.push(["点看板", vis()]);
      $$("#lstdbtn").click(); await wait(800);  log.push(["再点标准表", vis()]);
      $$("#lsheetbtn").click(); await wait(2000); log.push(["再点记录表", vis()]);
      $$("#lsheetbtn").click(); await wait(600); log.push(["重复点记录表(应回录入)", vis()]);
      /* 记录表里点「出检验报告」应载入该批并跳到报告表单 */
      $$("#lsheetbtn").click(); await wait(1500);
      pick($$("#lrec-date"), "2026-07-30"); await wait(700);
      const rows = document.querySelectorAll("#lrec-table tbody tr").length;
      const btn = document.querySelector("#lrec-table [data-rpt]");
      const model0 = btn ? btn.closest("tr").querySelector("td.nm").textContent : "";
      if (btn) btn.click();
      await wait(1200);
      log.push(["点出检验报告", Object.assign(vis(), {
        报告表单已展开: !$$("#lrpt").hidden,
        载入的品名: $$("#lmodel").value,
        记录表行数: rows, 表里第一批品名: model0,
        报告编号: $$("#lr-no").value })]);
      /* 在别的视图上点「+新批次」/ 选批次，应当自动跳回录入页 */
      $$("#ldashbtn").click(); await wait(2000);
      $$("#lnew").click(); await wait(900);
      log.push(["看板上点+新批次", vis()]);
      $$("#lsheetbtn").click(); await wait(1500);
      $$("#lpickbtn").click(); await wait(700);
      const row = document.querySelector("#lplbody .plrow");
      if (row) row.click();
      await wait(1200);
      log.push(["记录表上选批次", vis()]);
      window.__VIEWLOG = log;
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "dash"){
      await loadHist();
      $$("#ldashbtn").click(); await wait(2000);
      pick($$("#ld-range"),"all"); await wait(800);
      document.title = "DEMO:ready"; return;
    }

    if (MODE === "report"){
      pick($$("#lmodel"),"F2030"); await wait(200);
      const vals = {den:[19.8,19.9,20.2], hard:[33,30,36], reb:[50,49,49],
                    ifd:[74.9,76.3,78.8], cs:[10,11,10]};
      for (const k of Object.keys(vals))
        vals[k].forEach((v,i)=>fire(document.querySelector('[data-lv="'+k+'"][data-i="'+i+'"]'),String(v)));
      await wait(300);
      const cb = $$("#lfat-on"); cb.checked = true;
      cb.dispatchEvent(new Event("change",{bubbles:true})); await wait(150);
      fire($$("#lfat-h"),"2.13"); fire($$("#lfat-i"),"33.19"); await wait(300);
      $$("#lprt").click(); await wait(400);
      fire($$("#lr-sup"),"SERIM"); fire($$("#lr-mat"),"蓝色海绵");
      fire($$("#lr-spec"),"30*30*5"); fire($$("#lr-temp"),"26"); fire($$("#lr-rh"),"60");
      await wait(400);
      $$("#lrpt-print").click();               /* 构建 #lsheet，window.print 已被吞掉 */
      await wait(600);
      document.title = "DEMO:ready"; return;
    }
  })();
})();
`;

const i = src.lastIndexOf('})();');
if (i < 0) throw new Error('找不到 IIFE 结尾');
fs.writeFileSync(outFile, src.slice(0, i) + demo + '\n' + src.slice(i), 'utf8');
console.log('写出', outFile, '模式', mode);
