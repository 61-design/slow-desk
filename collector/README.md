# 慢慢书桌统计

生产方案：GitHub Pages 网站 → Supabase Edge Function `slow-desk-stats` → Postgres。`/stats.html` 是公开的免登录统计页，音乐首页不放入口；任何拿到网址的人都能查看页面上的汇总和最近记录。Cloudflare 保留回滚副本，采集额度设为 0。

## 目录

- `supabase/index.ts`、`handler.mjs`、`validation.mjs`：生产接收和鉴权接口。
- `supabase/migrations/`：只创建 slow_desk 前缀的表/函数及独立保留策略，不修改其他应用数据。
- `catalogue.mjs`：实际歌曲白名单，由 `node build-catalogue.mjs` 生成。
- 根目录 `stats.html / stats.css / stats.js`：独立公开统计页。
- `worker.mjs / admin.mjs / schema.sql`：停用的 Cloudflare 实现，供回滚参考。

## 权限与登录

`slow_desk_events` 和 `slow_desk_settings` 启用 RLS，撤销 PUBLIC、anon、authenticated 表权限；统计 RPC 也仅 service_role 可执行。Edge Function 的匿名采集入口只接受固定字段、来源与曲库；`/api/stats` 免登录返回公开概览，逐人明细接口仍需签名凭证。服务密钥始终只在 Edge Function 内部使用。

旧管理员密钥保存在本机 `admin-key.local.txt`，权限 600、Git 忽略；数据库只保存 SHA-256 摘要。公开统计页不再使用它。Supabase 服务密钥只由 Edge Function 默认环境读取，不写入前端或源码。

## 数据口径和上限

仅 page_view、play_start、listen_30s 三类事件，不收集 IP、姓名、搜索词、完整 URL 或工作文字。自然声、总收听时长和实时在线不在本版统计范围。

按北京时间每天最多 1,000 条，每秒最多 5 条、每分钟最多 30 条。数据库事务锁确保并发时去重/额度一致；网络失败不重试，避免重复或阻塞播放。来源依赖链接标记，不能把 direct 解读成非微信。

独立 Cron 每日清理接收时间超过 62 天的记录，并清理本任务超过 7 天的运行日志。免费项目仍受 Supabase 账户总配额约束。

## 测试与发布

本地测试：`node --test supabase/handler.test.mjs ../qa/analytics.test.cjs ../qa/stats.test.cjs`。
线上模拟事件验证记录仅存本地 `supabase-live-verification.local.json`，测试事件始终与正式数据分开。公开概览已验证免登录可读；原始表、RPC 和逐人明细仍不向匿名访问开放。手机微信确认项目域名可达，不等于已经替用户在手机操作了整个播放流程。

接收函数文件包含 index.ts、handler.mjs、validation.mjs 和相对路径 catalogue.mjs。部署后先在 slow_desk_settings 中设置 test_data=true，核对三类事件、重复事件和统计隔离；再设置 test_data=false，更新前端 endpoint 并发布。管理员摘要单独设置，不加入迁移文件。

## 停用与回滚

网站回滚标签 `rollback/before-cloudflare-analytics-20260920` 指向 `fa35127`。紧急停用先清空网站 analytics-config.js 的 endpoint，再把 slow_desk_settings.daily_cap 设为 0；保留数据库，不删除历史记录。Cloudflare 旧版本及原配置备份在项目外的 `慢慢书桌统计直存_20260920/collector-before`。
