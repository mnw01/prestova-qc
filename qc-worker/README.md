# prestova-qc — 后端 + 同步

线上：https://qc.prestova.workers.dev

## 资源
- Worker: `qc`（账号子域 prestova）
- D1:     `prestova-qc` (b2706e7f-9999-4084-bead-06cdb2db07e2, APAC)
- R2:     `prestova-photos` （APAC，必须从 Cloudflare 后台建才能指定区域，
          命令行的 --location 是 best-effort，实测四次都被放到 ENAM。
          桶的区域建完不可改。）
- 秘钥:   QC_PASSCODE / QC_COOKIE_SECRET（用 wrangler secret 管理，不在代码里）

## 常用命令
    npm install
    npm run migrate:list                             # 有无未应用的迁移
    npm run migrate                                  # 应用迁移到线上
    npm test                                         # 后端单元测试（84 项）
    npx wrangler secret put QC_PASSCODE --name qc    # 改访问口令
    npx wrangler tail                                # 实时日志
    npx wrangler deploy                              # 手动部署（平时不用，走 CI）

## 改前端后怎么发布
前端源文件在 `../前端源文件-prestova-inspection-report.html`。改完 `git push`
就行 —— Cloudflare Workers Builds 自动构建并部署，实测 43~52 秒。

`build-standalone.js` 现在一次写出 `../index.html` 和 `public/index.html` 两份，
以前那个手动 `cp` 不需要了。本地想先看效果就跑 `node ../build-standalone.js`，
产物与 CI 构建的逐字节相同（靠 `.gitattributes` 统一换行，否则 Windows 上会多
出 9638 字节的 CR）。

**动了表结构就先 `npm run migrate` 再 push**，顺序反了这中间就是线上 500。

## 跨设备同步测试（两个浏览器配置模拟两台设备）
    node serve-worker.mjs 8801        # 用真实 worker.js 起本地 HTTP（口令 test1234）
    node probe.mjs 2                  # 收测试结果
    # 然后用两个不同 --user-data-dir 的 Chrome 分别打开
    #   http://localhost:8801/?phase=A   (写)
    #   http://localhost:8801/?phase=B   (读，全新配置)
serve-worker.mjs / driver.js 只用于测试，不会被部署。

## 已知环境问题
本机 `wrangler dev` 会崩（workerd 在这台 Windows 报 access violation，
需装新版 Microsoft Visual C++ Redistributable）。`wrangler deploy` 不受影响。

## R2 区域的坑（2026-07-31）
`wrangler r2 bucket create --location apac` 会回 "with location hint apac"，
但实际落在 ENAM——位置提示是 best effort，Cloudflare 按调用方位置自动选。
直接调 REST 接口传 locationHint 也不行（wrangler 的 OAuth token 没有 R2 scope，
返回 Authentication error）。
**唯一可靠的办法：Cloudflare 后台建桶时用 Location 下拉框明确选 Asia-Pacific。**
桶区域建完锁死，改不了，只能删桶重建 + 迁数据。

迁移做法（照片不多时）：
    npx wrangler r2 object get  <旧桶>/<id>/<slot>.jpg --remote --file bak.jpg
    # 后台建新桶（选区域）
    npx wrangler r2 object put  <新桶>/<id>/<slot>.jpg --remote --file bak.jpg --content-type image/jpeg
    # 改 wrangler.toml 的 bucket_name，再 npx wrangler deploy
迁完用 sha256 比对确认字节一致。`r2backup/` 里是这次迁移的备份。

## iPhone 打印是 4 页怎么办（不要改代码）
`.sheet` 固定 274mm 是为了让桌面/安卓填满两页、照片保持 29.7mm。
iOS 可打印区域更小（iOS 上所有浏览器包括 Chrome 都是 WebKit），会分成 4 页。

**解决办法：在 iPhone 的打印面板里把「缩放」调低**，不用改任何代码。
按 274mm 反算需要的缩放上限：

    iOS 页边距 12mm (可打印 273mm) -> 99%
              15mm (267mm)        -> 97%
              18mm (261mm)        -> 95%
              21mm (255mm)        -> 93%
              24mm (249mm)        -> 90%

**设 90% 覆盖所有情况**，想清晰一点可先试 95%。
打印面板底部直接显示「页码 1/2」或「1/4」，调完看一眼即可确认。

不要为了 iOS 去改 274mm——试过 250mm（照片缩到 23mm）和取消固定页高
（页脚留白、照片 20mm），都牺牲了填满效果，用户已明确否决。
