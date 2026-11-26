# `colab-canvas` 开发路线图与 Phase 0 验证计划

> rev.2：按架构审计结果重排 Phase 0 优先级（先验证“会不会烧钱”，再验证“好不好用”）。架构细节见 [architecture.md](./architecture.md)。

---

## 1. MVP v0.1 边界

### In-Scope（v0.1 必须完成）
- **Colab Gateway + 账号池（轮换）**：导入加密存储的 ADC 凭据；按优先级 + 余额底线（默认 5 CU）选号；正确处理 412 / 400 错误；不做跨账号并发。
- **单 Worker + 三层 Cost Guard**：FIFO 队列复用一台 L4；`colab exec` 冷启动；单条 ControlMaster SSH 同时转发 8188 / 8189；控制面空闲计时 + VM Watchdog `runtime.unassign()` + 对账（不碰 `external` 会话）；Emergency Stop。
- **Anima 工作流**：单个 `anima` 包，变体 `turbo` / `aesthetic`（`base` 仅管理员可见）；权重按需拉取；Batch 1–4；管理员登记的 LoRA。
- **存储**：WebP 缩略图 + Outbox + `GoogleDriveStorage`（`drive.file`）/ `LocalStorage`。
- **鉴权与配额**：`AUTH_MODE=hybrid`；单次批量上限、每人排队上限 2、每日配额。
- **UI**：Studio / Gallery / Pool & Admin，React + Tailwind v4 + shadcn/ui，现代极简 × 轻日系柔色。
- **部署**：多架构单容器 + 可选 `cloudflared`，应用端口不对公网发布。

### Out-of-Scope（v0.2+）
- 多 Worker / 跨账号并发出图（受服务条款约束，默认不做）。
- Z-Image-Turbo、FLUX.2 [klein]、Qwen-Image、Hires Fix、img2img / 局部重绘。
- 网页导入自定义 `workflow_api.json`；普通用户自行添加 LoRA。
- LoRA 预缓存、按人统计 CU 报表、双语 README、CI 多架构发布流水线。

---

## 2. 环境分工

（私有主机名只作为团队流程约定，不得写进代码或公开配置。）

| 环境 | 形式 | 用途 |
| :--- | :--- | :--- |
| 本机 macOS | 原生 Python / Node + Apple `container` | 日常开发与热重载；Phase 0 大部分 spike（本机已有 `colab` 0.8.0、`gcloud`、`ssh`、`container` 1.7.1）；arm64 镜像冒烟 |
| `Linux Docker 主机` | Linux Docker / Compose | 无钥匙串的 Linux 环境：验证 HOME 隔离、ADC、ControlMaster 隧道、compose 编排、非 root 权限、amd64 构建 |
| `海外 VPS` | Docker + Cloudflare Tunnel / Access | 海外直连下实测冷启动与 Drive 吞吐；生产部署与最终验收 |

> [!NOTE]
> 默认本机 ADC 若缺少 `colaboratory` scope，可通过 `CLOUDSDK_CONFIG` 隔离签发每账号独立的 ADC JSON（见 `spike/README.md`，已在 P0-3 实测通过）。

---

## 3. Phase 0：技术验证（下一步）

产出放在 `spike/` 目录（不进生产镜像），每项一个独立脚本，结果回填下表。**P0-1 不通过不得进入 Phase 1。**

| # | 验证项 | 操作 | 通过标准 |
| :--- | :--- | :--- | :--- |
| **P0-1** | **VM 内自毁释放（最高优先级）** | `colab new --gpu L4` → 用 `colab exec` 在 kernel 内 `Popen` 一个测试 Watchdog（超时设为 2 分钟），到期调用 `google.colab.runtime.unassign()`；同时记录 kernel 环境中是否有 `TBE_RUNTIME_ADDR`，以及通过 SSH 启动的进程中是否有 | 到期后 `list_assignments()` 中该 endpoint 消失，`get_consumption_user_info().assignments_count` 归零；明确记录哪种启动方式可用。**若都不可用**：回退方案（如 kill kernel 后依赖 Colab 空闲回收，并测出回收耗时）写入文档，并相应缩短控制面空闲计时 |
| **P0-2** | **SSH 连接上限与复用** | 在同一 VM 上依次开第 1、2、3 条 `colab ssh`，记录在哪一条收到 429 及返回的 `limit`；再用 `-M -S sock` 建立 ControlMaster，同时转发两个端口并通过 `-S` 执行远程命令；人为断网后重连 | 得到当前套餐的实际连接上限；单连接同时完成双端口转发和远程命令；重连脚本可在 60 秒内恢复转发 |
| **P0-3** | **多账号隔离（库 + HOME）** | 两个账号各签发一份 ADC → 进程内分别构造 `Client(Prod(), AuthorizedSession(creds))` 调用 `get_consumption_user_info` / `list_assignments`；SSH 代理子进程使用不同 `HOME` 并发运行 | 两个账号的余额、会话互不串台；不读取系统钥匙串；各自 HOME 下 `settings.json` / `history` / `colab.log` 互相独立；关闭升级检查后 stdout 无横幅 |
| **P0-4** | **Drive 长期授权** | 自建 OAuth 客户端（Desktop）→ 只申请 `drive.file` → 同意屏幕发布为 In production → 无头授权一次 → 创建 `colab-canvas/` 根目录 → 上传 / Range 读取 / 删除测试 PNG | 发布过程无需审核；刷新令牌在“发布”状态下签发（7 天后复测仍有效，复测结果补记）；读写延迟达到秒级 |
| **P0-5** | **冷启动耗时** | `vm_bootstrap.py` 经 `colab exec` 执行：锁定 commit 的 ComfyUI + 排除 torch 的依赖安装 + `hf_transfer` 只下载 turbo 变体 + 启动 + `/system_stats` 探活；在本机与海外 VPS 各测一次 | 分阶段计时（assign / 依赖 / 权重 / 启动）；总耗时目标 < 180 秒；确认 Colab 预装 torch 与锁定的 ComfyUI 版本兼容 |
| **P0-6** | **出图与 LoRA** | 通过隧道提交 `turbo` 与 `aesthetic` 的 1024×1024 API JSON，监听 WebSocket 进度，用 `/history/{prompt_id}` 取图；运行中下载一个 LoRA 后再次提交 | 记录两档单张耗时与显存峰值；LoRA 无需重启即可生效；断开隧道后重连仍能通过 `/history` 取回图片；确定 `manifest.yaml` 的最终文件名与 SHA256 |

### 实测记录表（执行后回填）

| # | 环境 | 结果 | 关键指标 | 问题与决策 |
| :--- | :--- | :--- | :--- | :--- |
| P0-1 | 本机 macOS (`L4`) | **PASS** | `TBE_RUNTIME_ADDR` 可用于：kernel ☑ / ssh ☐；释放耗时 `81.34 s`（75s 超时后 `+6.34 s`） | SSH 壳无 `TBE_RUNTIME_ADDR=172.28.0.1:8011`，Watchdog 必须由 Jupyter kernel `Popen` 拉起；触发 `runtime.unassign()` 后 `assignments_count` 自动归零 |
| P0-2 | 本机 macOS (`L4`) | **PASS** | SSH 连接上限 `1`；ControlMaster 建立 `4.56 s` / 重连 `4.56 s` | 第 2 条独立 SSH 直接被拒绝 `HTTP 429 already-active-session`；必须单连接 ControlMaster（`ControlPersist=no` 前台守护）复用双端口转发与远端命令 |
| P0-3 | 本机 macOS | **PASS** | 隔离 ☑；无钥匙串 ☑；stdout 干净 ☑ | 2 个独立账号并发调用 `Client` 与隔离 `HOME` 下的 `colab --auth adc --config ... sessions`，返回各自正确的余额、会话与独立 `colab.log` / `settings.json`，无钥匙串读取且 stdout 无升级横幅 |
| P0-4 | 本机 macOS | **跳过（推迟）** | 默认改用 `LocalStorage`；Drive 验证延后 | v0.1 先使用 `LocalStorage` + Outbox 落地跑通全链路，`spike/p0_4_drive.py` 已就绪，后续配置好 GCP Desktop OAuth 后随时补验接入 |
| P0-5 | 本机 macOS (`L4`) | **PASS** | assign `42.14 s` / deps `10.44 s` / weights `50.45 s` / launch `27.05 s` = `134.63 s`（bootstrap `92.49 s`） | `torch 2.14.1+cu130` 与 ComfyUI `0.46.0` (`4a4b3409...`) 兼容；assign 偶发 503，需 `COLAB_CLI_ASSIGN_RETRIES>=5`；`HF_HUB_ENABLE_HF_TRANSFER` 已弃用，改用 `HF_XET_HIGH_PERFORMANCE=1` |
| P0-6 | 本机 macOS (`L4`) | **PASS** | turbo `16.15 s`（冷加载）/ `5.43 s`（热态）；aesthetic `27.26 s`（下载 `19.18 s`）；VRAM `5.52 GB` (`5656/23034 MB`)；LoRA ☑（`9.75 s`，免重启） | 断线后 `/history/{prompt_id}` 成功取回 `1,343,260 bytes` PNG；确定权重文件 `anima-turbo-v1.1.safetensors` (`fba11953...`)、`anima-aesthetic-v1.1.safetensors` (`3c186838...`)、`qwen_3_06b_base.safetensors` (`cd2a5120...`)、`qwen_image_vae.safetensors` (`a70580f0...`) |

---

## 4. Phase 1：MVP 里程碑

- **M1 · 骨架、安全与存储**：FastAPI + SQLite 迁移；Fernet 凭据加密；`AUTH_MODE=hybrid`（JWT 校验 `aud` / 团队域名）+ 邀请码 + 配额；`StorageAdapter` + Outbox 上传器 + WebP 缩略图；SSE 总线（心跳、`Last-Event-ID`）。
- **M2 · Colab Gateway 与 Worker**：`gateway.py`（锁定 0.8.0）；账号池轮换 + 错误映射；`WorkerManager`（FIFO、`colab exec` bootstrap、ControlMaster 隧道、心跳）；`vm_watchdog.py`；对账（managed / external）；Anima 工作流包 + LoRA 注入；ComfyUI WebSocket 进度转 SSE。
- **M3 · 前端**：Studio / Gallery / Pool & Admin（按 architecture §3.6）。
- **M4 · 打包与上线**：多架构镜像；先在 Apple `container` 和 Linux Docker 上冒烟，再部署到海外 VPS + Cloudflare Tunnel / Access。验收场景：
  - 多人同时排队；
  - 空闲自动停机；
  - **杀掉控制面容器后，Watchdog 能在超时后释放 VM**；
  - Drive 断网时 Outbox 堆积，恢复后补传；
  - 手动开的 Colab notebook 不受影响。

---

## 5. Phase 2：v0.2 方向

1. 更多工作流包（Z-Image-Turbo、FLUX.2 [klein]、Qwen-Image、Hires Fix、img2img）。
2. 管理员网页导入自定义工作流并绑定参数。
3. LoRA 预缓存与预览图管理。
4. 按人 CU 估算报表。
5. 双语 README、一键部署脚本、GitHub Actions 多架构镜像发布。
6. 跳过 SSH、直接走 runtime proxy 访问 ComfyUI 的可行性调研（未验证，仅作为方向）。
