# CONTEXT

Voice Studio 的领域词汇表与核心不变量。初版提炼自 docs/generated/prd.md、ADR-0001 和 CLAUDE.md（2026-07-13），随实现演进维护。

## 项目一句话

Voice Studio 提供文字转语音和语音转文字。默认在 Apple Silicon Mac 上使用 Qwen3-TTS 合成、Whisper 转写，两个入口也可以切换到 OpenAI 云端引擎。

## 词汇表

| 术语 | 定义 | 避免的同义词 |
| --- | --- | --- |
| **InferenceEngine** | 本地合成契约：`(文本, 音色) → AsyncThrowingStream<AudioChunk>`。推理运行时全部细节（MLX/tokenization/KV cache/codec 解码/流式分帧）必须藏在它后面 | "TTS 服务"、"合成器" |
| **AudioChunk** | 推理引擎交付的 PCM 音频块，24 kHz；播放与导出消费的统一单元 | "音频帧"、"buffer" |
| **FakeInferenceEngine** | 预录音频块的假引擎，UI 开发和测试一律用它，不依赖真实模型；全项目测试基座 | "mock 引擎"、"stub" |
| **MLXInferenceEngine** | 真实现，基于 mlx-audio-swift（ADR-0001）；升级或替换被隔离在此模块内 | — |
| **StreamingAudioPlayer** | 消费 AudioChunk 流的播放引擎，隐藏流式缓冲与 AVFoundation 细节；边合成边播 | "音频播放器" |
| **ModelManager** | 隐藏 Hugging Face 下载、断点续传、完整性校验与磁盘布局；对外是列出/下载(带进度)/删除/就绪状态 | "下载器" |
| **音色（speaker）** | 官方 9 个预置 speaker，数据驱动枚举；MVP 只做预置音色 | "voice"、"角色" |
| **个人任务历史（Task history）** | 归属于提交账号的语音合成与转写记录。完成的任务保存可重复下载的音频或文本，失败和取消的任务保留状态。 | 审计日志 |
| **模型变体** | Base / CustomVoice / VoiceDesign × 0.6B / 1.7B；默认 0.6B-CustomVoice-8bit（约 1.8 GB），1.7B（约 2.9 GB）作音质选项 | — |
| **TTFB / RTFx** | 首包延迟 / 实时率。MVP 标准：TTFB < 2s、RTFx > 1；实测（M3 Max，8bit）0.11~0.13s / 3.4~4.1 | — |
| **对话脚本（DialogueScript）** | 纯文本行级标记的多角色稿：「角色名：台词」每行一段，括号携带每段指令；无标记文本退化为单音色合成（ADR-0002） | "剧本"、"多人模式" |
| **台词段（DialogueLine）** | 对话脚本解析出的最小合成单元：角色 + 可选行内指令 + 文本；角色为 nil 是旁白段（用主音色）；逐段送入 InferenceEngine 顺序流式播放 | "句子"、"片段" |
| **角色绑定（RoleBinding）** | 脚本中检测到的角色名 → 音色+合成选项的映射；一场对话内所有绑定必须同一模型变体（ADR-0002）；存在未绑定角色时 DialogueSynthesizer 在合成开始前快速失败 | "配音分配" |

## 核心不变量

- **接口先于运行时**：任何上层代码只依赖 InferenceEngine 协议，不感知 MLX。
- **取消语义必须正确**：用户中途停止时，流终止、推理任务释放、无内存泄漏。
- **TTSCore 零 MLX 依赖**：保住 `swift build` / `swift test` 快速内循环；凡链接 MLX 的产物必须用 xcodebuild 构建（见 CLAUDE.md 与 ADR-0001）。
- **音频契约**：输出 24 kHz PCM/wav；导出支持 wav 与 m4a。

## 决策指针

- ADR-0001 `docs/adr/0001-inference-runtime-mlx-swift.md` — 推理运行时选 MLX Swift；spike 数据见 `docs/generated/spike-inference-runtime.md`。
- ADR-0002 `docs/adr/0002-dialogue-mode-single-variant.md` — 对话模式单变体边界 + 行级标记脚本。
- PRD `docs/generated/prd.md` — MVP 范围与用户故事。
