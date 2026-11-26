# Phase 0 Spike Scripts (`colab-canvas`)

本目录用于 Phase 0 技术验证，验证脚本与测试产出的本地临时目录（`spike/.venv/`、`spike/.local/`）已在 `.gitignore` 中排除，不会进入版本库或生产镜像。

## 脚本清单

| 脚本 | 验证项 | 说明 |
| :--- | :--- | :--- |
| `p0_1_watchdog.py` | **P0-1** VM 内自毁释放 | 验证从 kernel 内启动 Watchdog 后调用 `google.colab.runtime.unassign()` 是否能自主释放 L4 计费实例 |
| `p0_2_ssh.py` | **P0-2** SSH 复用与上限探测 | 验证 ControlMaster 单连接复用多端口转发+远程命令、断线重连及真实 429 并发连接上限 |
| `p0_5_p0_6_comfy_anima.py` | **P0-5 & P0-6** 冷启动与 Anima 出图 | 实测干净 L4 冷启动（固定 ComfyUI commit、跳过 torch 重装、`hf_transfer` 只拉 turbo）、出图、按需拉 aesthetic、动态 LoRA、断线 `/history` 恢复 |
| `p0_3_isolation.py` | **P0-3** 多账号 ADC 隔离 | 需要你额外签发 2 个账号的隔离 ADC JSON 后运行 |
| `p0_4_drive.py` | **P0-4** Google Drive 长期授权 | 需要你在 GCP 创建一个 Desktop OAuth 客户端（仅 `drive.file`，发布为 In production）后运行 |

---

## 完成 P0-3（多账号 ADC 隔离）

为了不覆盖你本机 `~/.config/gcloud/application_default_credentials.json`，用 `CLOUDSDK_CONFIG` 隔离两次登录配置：

```bash
# 账号 1
mkdir -p spike/.local/gcloud_acc1
CLOUDSDK_CONFIG="$PWD/spike/.local/gcloud_acc1" gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory

# 账号 2
mkdir -p spike/.local/gcloud_acc2
CLOUDSDK_CONFIG="$PWD/spike/.local/gcloud_acc2" gcloud auth application-default login \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory

# 运行隔离与并发测试
spike/.venv/bin/python spike/p0_3_isolation.py \
  --acc1 spike/.local/gcloud_acc1/application_default_credentials.json \
  --acc2 spike/.local/gcloud_acc2/application_default_credentials.json
```

---

## 完成 P0-4（Google Drive 长期授权）

1. 在 Google Cloud Console 创建一个项目，启用 **Google Drive API**。
2. 配置 OAuth 同意屏幕（OAuth consent screen）：仅添加 scope `https://www.googleapis.com/auth/drive.file`，并将 Publishing status 设为 **In production**（不要停留在 Testing，否则 Refresh Token 7 天过期）。
3. 创建 **Desktop app** 类型的 OAuth Client ID 并下载 JSON 到 `spike/.local/drive_client_secret.json`。
4. 运行验证脚本（首次会打开浏览器授权，之后把 Refresh Token 写入 `spike/.local/drive_token.json`）：

```bash
spike/.venv/bin/python spike/p0_4_drive.py \
  --client-secrets spike/.local/drive_client_secret.json
```
