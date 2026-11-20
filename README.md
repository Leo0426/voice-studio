# Voice Studio · 文字与语音互转

在 macOS 客户端或网页中输入文字生成语音，也可以把录音转成文字。默认使用本机模型，下载后可以离线使用。两个入口都可以选择 OpenAI，由云端处理本次提交的文字或音频。

| 我要做什么 | 怎样使用 |
| --- | --- |
| 文字转语音 | 输入文字，选择音色，点击合成。可以试听并导出音频。 |
| 语音转文字 | 选择音频的语言（中文或英语），再选音频文件或直接录音。转写完成后可以复制文字。 |
| 找回之前的结果 | 登录原账号，从工作台或账号中心打开「任务历史」，可反复试听、下载已生成的音频，或下载转写文本。 |

### 个人任务历史

同一台 Mac 上的网页版、Mac 客户端和原生 Qwen 设备工作台共用个人历史。文字转语音和语音转文字各在模块下方按最新优先展示历史，每页 5 条。已完成的合成保存原始 WAV、MP3 或 FLAC，转写保存 UTF-8 TXT。再次下载直接读取已保存的文件，无需重新运行模型或支付云端调用费用。已提交给引擎但失败或取消的任务显示相应状态。[打开任务历史](http://127.0.0.1:4317/history.html)

历史属于提交任务的账号。已登录的用户随时可以查看和删除自己的结果，包括后来被撤销转换权限的用户。删除单条记录会同时删除保存的文件，删除账号会一并清除其个人历史。用于转写的输入录音只在处理期间使用。

原生设备工作台的单个 WAV 最多可存入历史 512 MiB。超过上限时，可在当前合成结果中手动导出。

个人历史从此版本起记录。旧版原生工作台的无账号记录仍在 `~/Library/Application Support/Qwen3TTS/History/`，可在 Finder 中打开已有 WAV。早期网页转换结果只保存在当次页面或手动下载的位置。

## 账号与访问权限

网页版与 Mac 客户端在同一个 macOS 用户下共用账号、角色和审计记录。首次打开时，选择自己的管理员用户名和密码。在 Mac 窗口复制首次设置码，或在仓库目录运行 `npm run setup-code` 查看。将设置码填入首次设置页即可登录。初始化完成后，由管理员在账号中心添加其他用户。[打开账号中心](http://127.0.0.1:4317/account.html)

| 内置角色 | 可执行的操作 |
| --- | --- |
| 管理员 | 全部语音操作、设备管理、密钥管理、用户和角色管理、审计。工作区始终至少保留一名启用的管理员。 |
| 成员 | 使用本机和 OpenAI 进行文字转语音、语音转文字。调用 OpenAI 使用工作区已配置的密钥。 |
| 审计员 | 查看账户、授权变更及业务请求记录。 |

在「角色」中新建自定义角色，选择直接权限或继承其他角色，再在「用户」中分配。用户可以同时拥有多个角色，实际权限取所有直接和继承权限的并集。例如，只授予「本机文字转语音」即可建立离线朗读账号。角色管理和用户管理可以分别委派，受委派者只能授予自己拥有的权限。

用户可以修改自己的密码，管理员可以重置密码、停用或删除可管理的用户。授权变化从下一次受保护操作生效，停用、删除、修改或重置密码会使该账号的现有会话失效。网页和 Mac 客户端分别登录，会话最长 12 小时。Mac 客户端重新启动后需要再次登录。审计页显示最近 200 条记录，包含操作者、时间和操作类型，且不记录语音内容、密码或 API 密钥。

账号数据库保存在 `~/Library/Application Support/Voice Studio/access.sqlite`。服务绑定本机回环地址。这些权限控制通过 Voice Studio 执行的操作，macOS 文件访问由操作系统控制。模型、密钥和音色库属于本机工作区。原生设备工具需要「管理本机模型和音色库」及「本机文字转语音」两项权限。可用 `VOICE_STUDIO_AUTH_DB` 指定其他数据库，独立存储用户、角色、会话、审计及个人任务结果。

## macOS 客户端

打开 Voice Studio 并登录，选择转换方式和引擎。客户端内置本机服务，可独立启动。首次使用本地 Qwen3-TTS 时，设备管理员可在原生设备工具的模型下载中心安装预置音色模型。选择本地 Whisper 时，首次转写会自动下载识别模型。点击录音时，系统会请求麦克风权限。

### 使用 OpenAI

在合成设置中选择 OpenAI 和内置音色，点击「试听音色」即可播放程序内置的中文 MP3。13 个样例使用同一段文字由 OpenAI 生成，试听使用本地资源，无需 API Key。

管理员在「账号中心 → OpenAI 密钥」中粘贴已有的 API Key 并保存。拥有 OpenAI 转换权限的成员直接使用工作区的配置。[打开网页版密钥设置](http://127.0.0.1:4317/account.html#openai-key)

原生客户端和网页服务共用本机文件 `~/Library/Application Support/Voice Studio/openai.env`。密钥只在首次输入或更换时填写，界面仅显示配置状态。若通过 `OPENAI_API_KEY` 环境变量配置，或在启动网页服务前把它写入项目的 `.env.local`，相应进程优先使用该值，更换时需修改启动配置并重启。网页仅访问本机服务，后续由服务携带密钥调用 OpenAI。

| 页面 | 可调设置 |
| --- | --- |
| [OpenAI 文字转语音](http://127.0.0.1:4317/?engine=openai#tts) | 选择模型、内置音色或已授权的自定义音色，设置风格、情绪、口音、语速及补充朗读指导。成品可试听并导出 WAV、MP3 或 FLAC。 |
| [OpenAI 语音转文字](http://127.0.0.1:4317/?engine=openai#stt) | 让 `gpt-transcribe` 自动检测语言，或指定一种、多种语言。可填写录音背景，以及人名、品牌等希望准确识别的关键词。适用于文件与麦克风录音，单个文件上限为 25 MB。 |

朗读默认使用 `gpt-audio-1.5`，也可选 `gpt-audio-mini`。两者每次最多 800 个字符，通过朗读指导控制节奏。专用 `gpt-4o-mini-tts` 支持 0.25–4 倍语速和最多 4096 个字符。OpenAI 计划于 2027 年 1 月 6 日停用 `gpt-4o-mini-tts`，1 月 20 日停用 `gpt-audio-mini`。[音频生成指南](https://developers.openai.com/api/docs/guides/audio-chat-completions) · [语音合成参数](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) · [停用时间表](https://developers.openai.com/api/docs/deprecations)

已开通录音创建权限的 OpenAI 项目可在朗读设置中创建音色。上传本人按指定声明朗读的授权录音，取得授权 ID 后，再上传同一说话人的参考样本。已有该项目的授权 ID 可以直接使用。创建成功后可立即选用该声音，或复制 `voice_…` 到另一个客户端。[打开自定义音色页面](http://127.0.0.1:4317/?engine=openai#voice-create) · [官方自定义声音指南](https://developers.openai.com/api/docs/guides/custom-voices)

### 安装原生应用

运行 `scripts/package-app.sh` 生成 `dist/Voice Studio.app` 和可分发的 `VoiceStudio-v*-arm64.zip`。将应用拖进「应用程序」即可使用。早期 Qwen 客户端仍可从 [Releases](../../releases) 下载。

> 应用为 ad-hoc 签名（未经 Apple 公证），首次打开请**右键 →「打开」**，
> 或运行 `xattr -cr "/Applications/Voice Studio.app"` 移除隔离属性。

默认预置音色模型约 2 GB，Whisper base 识别模型约 295 MB。

### 本地 Qwen 合成功能

- **流式合成**：边生成边播放，M 系列芯片上首包约 0.1 秒（实测 M3 Max，8bit 量化）
- **三种发声方式**：9 个官方预置音色（含北京话、四川话方言）/ **声音克隆**（3 秒参考音频复刻）/ **语音设计**（自然语言描述凭空造声音，支持试听迭代）
- **风格指令**：如「用温柔的语气慢慢说」，每次合成级别的情感/语气控制
- **长文本**：按句子边界自动分段，整篇文章无缝连续播放
- **真实音频波形**：由合成采样实时绘制，点按/拖动跳转，0.5×~2× 变速不变调
- **剪贴板朗读**：打开原生设备工作台后，在任意 App 里复制文字，按 ⌃⌥⌘S 开始朗读，再按一次停止。可在设置中更换快捷键。退出设备工作台即注销快捷键。
- **模型下载中心**：官方 / 镜像 / 自定义下载源，自定义存储路径，下载进度与磁盘管理
- **细粒度配置**：模型规格（0.6B 快 / 1.7B 音质好）、10 语种、采样参数、流式分块、内存加载管理
- 历史记录持久化、WAV / m4a 导出

| 模型下载中心 | 语音设计 |
|---|---|
| ![模型下载中心](assets/screenshots/download-center.png) | ![语音设计](assets/screenshots/voice-design.png) |

### 原生合成系统要求

- Apple Silicon（M1 及以上）
- macOS 14+
- 磁盘：每个模型约 1.8 ~ 3 GB；内存：加载一个模型约 2 GB

### 构建原生客户端

打包需要完整 Xcode、Metal 工具链和官方 macOS arm64 Node.js 22.13 或以上发行版。脚本会将该发行版的运行时和许可证装入应用，安装应用的用户可直接运行。设置 `VOICE_STUDIO_NODE` 可指定构建时使用的 Node 可执行文件。

```sh
# 打包 .app（构建 + 组装 + ad-hoc 签名，产物在 dist/）
scripts/package-app.sh

# 开发内循环（TTSCore/UI，不涉及 MLX）
swift test
```

更多构建细节见 [CLAUDE.md](CLAUDE.md)。

## 网页版

需要 Node.js 22.13 或以上。在仓库根目录启动服务。如需使用本机模型，请先运行上面的打包命令，或将已构建的 Voice Studio 安装到「应用程序」。选择 OpenAI 时，网页服务可直接连接云端。

```sh
npm start
```

打开[本地工作台](http://127.0.0.1:4317/)。网页和原生客户端共用本机模型。网页版的本地合成每次最多 800 个字符，本地转写的音频上传上限为 50 MiB。网页录音在结束后转为 WAV，交给所选引擎识别。

服务只监听回环地址。通过 `PORT` 调整端口，通过 `QWEN_BRIDGE` 指定转换程序的路径。也可以把这两个选项写入仓库根目录的 `.env.local`。

### 部署到 NAS

在 NAS 上使用 `deploy/nas/compose.yaml` 启动 Node.js 服务和 HTTPS 反向代理。NAS 提供 OpenAI 转换。本机 Qwen 和 Whisper 继续通过运行模型的 Mac 提供。令以下变量指向 NAS 的实际配置。

- `VOICE_STUDIO_HOST` 为能解析到 NAS 内网地址、且在 TLS 证书中有效的主机名。
- `VOICE_STUDIO_BIND_IP` 为 NAS 内网地址，`VOICE_STUDIO_PORT` 默认为 `14443`。
- `VOICE_STUDIO_TLS_DIR` 为包含 `fullchain.pem` 和 `privkey.pem` 的证书目录。代理以只读方式挂载该目录，证书更新后重启代理。
- `VOICE_STUDIO_DATA` 为账号、任务历史和密钥的持久化目录，确保 UID `1000` 可写。更新和回退时使用同一目录。

在仓库根目录执行以下命令。首次使用时通过第二条命令获取一次性设置码，在 HTTPS 页面创建管理员，再从账号中心配置密钥。

```sh
docker compose -f deploy/nas/compose.yaml up -d --build --wait
docker compose -f deploy/nas/compose.yaml exec -T app npm run setup-code
```

## 架构与验证

- `Sources/TTSCore/` 与 `Sources/TTSEngineMLX/` 负责文本分段、Qwen 合成与音频输出。
- `Sources/SpeechToText/` 使用 Whisper 在本地识别音频。
- `Sources/OpenAISpeech/` 与 `web/backend/openai.mjs` 提供原生语音协议实现和共享工作台服务的 OpenAI 请求处理。
- `Sources/Qwen3TTSApp/` 提供原生界面，`Sources/QwenTTSBridge/` 将相同引擎提供给本地网页。
- `web/` 包含浏览器界面及本地 HTTP 服务，`npm test` 验证请求处理和转换程序调用。

## 致谢

- [Whisper](https://github.com/openai/whisper) — 多语言语音识别模型
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)（Apache 2.0）— 通义千问开源 TTS 模型
- [mlx-audio-swift](https://github.com/Blaizzy/mlx-audio-swift)（MIT）— Apple Silicon 原生推理运行时
- 量化权重来自 [mlx-community](https://huggingface.co/mlx-community)

## 许可证

[MIT](LICENSE)
