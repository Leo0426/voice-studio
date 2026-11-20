# Voice Studio

文字与语音互转工具，默认使用本地模型，并提供可选的 OpenAI 引擎。原生客户端使用 SwiftUI + SPM，支持 Apple Silicon 和 macOS 14+。仓库根目录运行 `npm start` 启动网页版，`npm test` 验证转换接口（Node.js 22.13+）。

## 构建与测试

本机 `xcode-select` 指向 CommandLineTools，但 CLT **缺 XCTest/Swift Testing 和 Metal 编译器**（MLX 依赖 Metal kernel 编译）。所有构建/测试命令必须带完整 Xcode 工具链：

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift run Qwen3TTSApp
```

Xcode 26 的 Metal 工具链是独立组件；如遇 `Failed to load the default metallib`，运行：
`xcodebuild -downloadComponent MetalToolchain`

**引入 MLX 依赖后**：SwiftPM 命令行无法编译 Metal shaders（mlx-swift README 明确说明），凡链接 MLX 的产物必须用 xcodebuild 构建：

```sh
xcodebuild build -scheme Qwen3TTSApp -configuration Release \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath .xcbuild -clonedSourcePackagesDirPath .build \
  -skipPackagePluginValidation -skipMacroValidation
```

（`-skipPackagePluginValidation` 是必需的：mlx-swift 的 CudaBuild 插件否则会被 xcodebuild 拒绝；`-clonedSourcePackagesDirPath .build` 让 xcodebuild 复用 SPM CLI 的依赖 checkout，避免重复拉取大仓库。）

打包 .app（构建 + 组装 + ad-hoc 签名 + zip + sha256，产物在 dist/，版本号取自 git tag）：

```sh
scripts/package-app.sh            # 完整构建后打包
scripts/package-app.sh --skip-build  # 直接用现有 Release 产物
```

纯 TTSCore/UI 开发（FakeInferenceEngine，不链接 MLX）仍可用 `swift build` / `swift test`。
`swift test` 能编译链接 MLX 的 target（Metal shaders 不编译，仅运行时缺 metallib）；
AppModelTests 全程假引擎，不触发 MLX 推理，所以照常通过。

## 发布

推 `v*` 标签即触发 `.github/workflows/release.yml`：CI 构建打包并创建 GitHub Release。
Release notes 放 `docs/release-notes/<tag>.md`，workflow 自动取用。

## 架构（详见 docs/generated/prd.md）

- `Sources/TTSCore` — 库：`InferenceEngine` 协议（文本+音色 → AsyncThrowingStream<AudioChunk>）是全 App 核心契约，运行时细节（MLX/Fake）必须藏在它后面；`StreamingAudioPlayer` 消费同一流。
- `Sources/Qwen3TTSApp` — SwiftUI 界面层。
- 推理运行时选型见 `docs/adr/`（spike 记录：docs/generated/spike-inference-runtime.md）。

## 约定

- UI 开发和测试一律用 `FakeInferenceEngine`，不依赖真实模型。
- 文档、注释、commit message 用中文。

## Agent skills

### Issue tracker
Issues 以本地 markdown 文件跟踪，存放在 `.scratch/<feature>/` 下，不自动发布到 GitHub Issues。见 `docs/agents/issue-tracker.md`。

### Triage labels
六个状态 label 使用 ForgeFlow 默认名称（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix / resolved）。见 `docs/agents/triage-labels.md`。

### Domain docs
单一上下文：根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。
