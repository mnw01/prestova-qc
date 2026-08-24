# 印尼荣升 · 在线质检报告系统

PT. Prestova Home Living Indonesia 的现场质检系统。**一个 HTML 文件 + 一个
Cloudflare Worker**，离线优先，QC 用手机在车间录入，断网照常干活，有网自动同步。

线上：`https://qc.prestova.workers.dev`

## 五个板块

| 板块 | 干什么 |
|---|---|
| 实验室 `lab` | 海绵物性测试，每批上/中/下三支，出 A4 检验报告 |
| 来料检验 `iqc` | 面布、海绵、弹簧等来料到货抽检，8 个检查项 |
| 制程检验 `ipqc` | 各车间工序不良记录，现场录入 |
| 成品检验 `fqc` | 每柜成品抽检，出 A4 两页报告（含 12~15 张照片） |
| 装柜检验 `oqc` | 装柜过程检查 + 货物明细核对 |

## 目录

```
前端源文件-prestova-inspection-report.html   ← 唯一的源文件，改这个
index.html                                   ← 构建产物，部署的就是它
build-standalone.js                          ← 构建：套 <head> 外壳 + 校验
check-isolation.js                           ← 板块隔离检查，不过就中断构建
qc-worker/
  src/worker.js       后端（认证、同步 API、照片直传 R2）
  migrations/         D1 表结构，唯一真相源（wrangler d1 migrations）
  load-schema.mjs     拼接 migrations/，供测试库和本地后端建表
  test.mjs            服务端单元测试（真实 worker + 内存 SQLite）
  wrangler.toml       Worker 配置
参考资料/            开发期的工具脚本（构建 demo、跑 harness、扫配色、灌词典）
```

## 开发

```bash
node check-isolation.js && node build-standalone.js
```

`build-standalone.js` 会先跑隔离检查再写 `index.html`。**隔离检查不过不会产出文件**
—— 每个板块的 CSS 必须限定在自己的根节点下（`#lab` / `#iqc` / `#ipqc` / `#oqc`），
历史上出过「实验室写了一条裸的 `.off` 把首页布局搞塌」这种事。

### 服务端测试

```bash
cd qc-worker && node test.mjs
```

### 端到端 harness

用真实的 `worker.js` + 内存 SQLite 起一个本地后端，页面用指定的 HTML：

```bash
node 参考资料/serve-test.mjs 8801 index.html <driver.js>
```

口令：`test1234`（QC）/ `boss9999`（管理员）。driver 注入页面里跑，
结果写 `window.__OUT`。

**注意**：cookie 按 host 存、不分端口，换端口重开 harness 不会换掉登录身份，
每次重跑前先 `POST /api/logout`。

## 部署

```bash
node build-standalone.js            # 隔离检查 + 同时写出两份产物
cd qc-worker && npx wrangler deploy
```

原来这里还有一步 `cp index.html qc-worker/public/index.html`，现在构建脚本自己写
两份了。那一步**忘了不会报错** —— wrangler 照样部署成功，现场跑的却还是旧页面。

### Workers Builds（GitHub 自动部署）

面板里 `qc` → Settings → Build，必须按这三项配，否则构建失败或部署出空壳：

| 项 | 值 |
|---|---|
| Root directory | `qc-worker` |
| Build command | `cd .. && node build-standalone.js` |
| Deploy command | `npx wrangler deploy`（默认值） |

Root 必须是 `qc-worker` —— 面板上的 Worker 名要跟该目录下 `wrangler.toml` 的
`name` 对上。build 要 `cd ..` 是因为构建脚本在仓库根目录，而 `public/` 不进仓库，
得在 CI 上现生成。Worker secret 不受部署影响，不用重设。

回滚：`npx wrangler rollback --name qc`（每次部署的版本都留着）。
数据回滚：D1 Time Travel，可回到 30 天内任意时间点。

### 必须配的 Worker secret

仓库里**没有**任何真实口令，跑起来前要自己设：

```bash
npx wrangler secret put QC_PASSCODE         # 现场检验员
npx wrangler secret put QC_ADMIN_PASSCODE   # 管理员
npx wrangler secret put QC_COOKIE_SECRET    # 会话签名用，随机长字符串
```

没配 `QC_ADMIN_PASSCODE` 时，`QC_PASSCODE` 仍然给 admin 角色（向后兼容）。

### 表结构与迁移

表结构的唯一真相源是 `qc-worker/migrations/`，走 wrangler 的 D1 迁移机制。
`0001_baseline.sql` 是 2026-08-24 时生产库的实际结构，全部 `IF NOT EXISTS`，
对已有库执行是空操作，对空库执行则建出与生产一致的结构。测试库和本地后端
也从这里建表（`load-schema.mjs`），所以它们跑的结构和线上一致。

```bash
cd qc-worker
npm run migrate:list           # 看有没有未应用的迁移
npm run migrate                # 应用到线上
npm run migrate:new -- 加XX列  # 新建一个迁移文件
```

**顺序不能反：先迁移，确认无误，再 git push。**

push 会立刻触发 CI 部署（实测 43~52 秒）。要是新代码读写的列还没加到线上库，
这中间就是线上 500。反过来先迁移是安全的 —— 多一个还没人用的列不影响旧代码。

**不要再手工 `ALTER TABLE`。** 手工改动不进 `d1_migrations`，重建库时会丢，
线上结构和 `migrations/` 也就此分家。`locked` 列当初正是这么跑偏的：线上被
ALTER 追加到了末尾，而 schema.sql 里写在 payload 之前，两边不一致，直到这次
逐列比对才发现。

## 几个绕不开的设计

**离线优先。** 数据先落 IndexedDB（`prestova-ir`），后台每 180 秒推拉一次
（只在页面可见时）。冲突用 last-write-wins，输掉的一方会拉服务端那份覆盖本地
**并弹提示告诉用户**。照片单独走 R2，不进 payload，同步覆盖时显式保留。

**两个 store。** `reports` 存完整记录（含照片 Blob），`meta` 存轻量索引。
列表、筛选、同步判断全走 `meta`，只有真要打开一条时才读 `reports`。
**改了 `metaOf()` 里任何一处推导就要把 `META_VER` 加 1**，开机对不上会整表重算。

**提交并锁定。** 记录上的 `locked` 是提交时刻的时间戳，跟着 payload 同步，
所以离线也能提交。服务端有对应的列，已锁的记录只有 admin 能 PUT ——
这不是安全加固，是功能必需：少了它，一台还没同步到锁状态的设备照样能改，
last-write-wins 会让它赢，把锁冲掉。

**记录表默认只看当月。** 三万条数据时不限量渲染会撑出 12 万个 DOM 节点，
进板块 1 秒、筛选框敲一下 4~5 秒（桌面，手机再乘 3~5）。
按月切 + 封顶 200 行之后回到几百个节点。

## 不进仓库的东西

真实业务数据（物料表、成品/装柜基础资料、1230+ 批实验室历史、检验照片）
和 63 MB 的 Chrome 调试配置目录都在 `.gitignore` 里。基础资料在应用里用
「导入 xlsx」现场加载，历史数据从服务端同步下来。
