# prestova-qc — 后端 + 同步

线上：https://qc.prestova.workers.dev

## 资源
- Worker: `qc`（账号子域 prestova）
- D1:     `prestova-qc` (b2706e7f-9999-4084-bead-06cdb2db07e2, APAC)
- R2:     `prestova-photos` （APAC，必须从 Cloudflare 后台建才能指定区域，
          命令行的 --location 是 best-effort，实测四次都被放到 ENAM。
          桶的区域建完不可改。）
- 秘钥:   QC_PASSCODE / QC_ADMIN_PASSCODE / QC_COOKIE_SECRET
          （用 wrangler secret 管理，不在代码里，也读不回来 —— 丢了只能重设）

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

## Workers Builds 的配置（2026-08-24 踩过大坑）
面板里的**根目录**和**构建命令**两个字段填了不生效 —— 存得进去、重新加载也
显示，但构建时读到的仍是旧值（连试三次，跨度 15 分钟）。原因没查明。

所以配置全部写进**命令字段**里，不依赖那两个字段：

    根目录     /
    构建命令   （空）
    部署命令   node build-standalone.js && git diff --exit-code index.html && cd qc-worker && npm test && cd .. && npx wrangler deploy --config qc-worker/wrangler.toml
    版本命令   node -v && node build-standalone.js && git diff --exit-code index.html && cd qc-worker && npm test && cd .. && npx wrangler versions upload --config qc-worker/wrangler.toml

命令里除了构建和部署，还串了两道守卫，任何一道不过都短路，不会部署：

- `git diff --exit-code index.html` —— 仓库里那份 index.html 是构建产物。改了
  源文件却忘了重新构建就 push 的话，CI 构建出来的和提交的不一致，这里当场红。
- `npm test` —— 84 项服务端测试（认证、路由、last-write-wins）。构建本身只检查
  前端的板块隔离，完全不碰 worker.js；没有这一步，改坏鉴权也会照常上线。

`node -v` 只在非生产分支跑，把 CI 的 Node 版本记进日志——测试用 node:sqlite，
需要 22.5+，哪天 CI 降级了从日志一眼能看出来。

`--config` 指向子目录的配置时，`main` 和 `assets.directory` 都相对**配置文件**
解析，所以里面的 `src/worker.js` 和 `./public` 不用改。

### 那次事故（线上坏了 13 小时）
根目录是 `/` 且没有构建命令时，`npx wrangler deploy` 在仓库根目录找不到
wrangler.toml，会**自作主张生成一份「静态网站」配置**（Framework: Static、
Output Directory: `.`）把整个 Worker 替换掉，后果：

- `/api/*` 全部 404 —— 前端第一次同步就失败，触发 `SYNC.enabled=false`，
  五个同步按钮静默隐藏、整个会话不再重试，**而且不给任何提示**
- 口令闸门失效，未认证也能拿到完整应用
- **三个密钥被全部清空**（`wrangler secret list` 返回 `[]`）
- 整个仓库根目录变成公开可下载的静态资源

面板上三次构建全部显示「成功」—— 从 CI 的角度它确实成功地部署了一个静态网站。

判断线上是否健康的最快办法：

    curl -s -o /dev/null -w "%{http_code}
" https://qc.prestova.workers.dev/api/logout

**200 = Worker 在跑**（这个路由在鉴权之前，无条件返回 200）。
**404 = Worker 被绕过**，静态资源在响应，按上面的配置重新部署并检查密钥。

顺带：`wrangler versions upload` 找不到配置时是干净报错退出，不会造成破坏 ——
只有 `deploy` 会自动生成配置。所以非生产分支构建失败是安全的。

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
