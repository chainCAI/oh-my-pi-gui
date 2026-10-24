# omp GUI — Plan Index

Complete planning documentation for the omp desktop GUI.
Source-verified against omp codebase (2026-08-01 audit).

## Documents

| # | Document | Content | Size |
|---|---|---|---|
| 00 | [Overview](./00-overview.md) | Philosophy, hard constraints, wire interfaces, v1 limitations | 3.3KB |
| 01 | [Architecture](./01-architecture.md) | Process model, modules, IPC, sidecar lifecycle, security | 9.2KB |
| 02 | [Features](./02-features.md) | 18 categories, 100+ features, all mapped to verified wire interfaces | 17.4KB |
| 03 | [UI Design](./03-ui-design.md) | Layout, 95-color theme, components, interactions, accessibility, shortcuts | 10.9KB |
| 04 | [Tech Stack](./04-tech-stack.md) | Electron 35 + React 19 + Tailwind 4, dependencies, package structure | 7.6KB |
| 05 | [Performance](./05-performance.md) | Targets, streaming batching, virtual scroll, memory, startup | 6.7KB |
| 06 | [Compatibility](./06-compatibility.md) | Platforms, binary resolution, CLI coexistence, signing, CI/CD | 5.7KB |
| 07 | [Sidecar Integration](./07-sidecar-integration.md) | Wire protocol spec: 42 commands, 24 events, 11 UI methods, 15 stats endpoints | 13.1KB |
| 08 | [Implementation Phases](./08-implementation-phases.md) | 8 phases, 15 weeks, task checklists, verification gates, risks | 10.5KB |
| 14 | [Parallel Sessions](./14-parallel-sessions.md) | Multi-window multi-sidecar pool (≤10), window↔sidecar 1:1, IPC/event routing, phases, risks | 18.7KB |
| 15 | [Parity Closeout](./15-parity-closeout.md) | TUI 对等收尾:三条 workstream、跨切面决策、5 阶段验证门、风险 |
| 16 | [Agent RPC Extensions](./16-agent-rpc-extensions.md) | 11 个新 RPC 命令的线路契约、插入点、错误语义 |
| 17 | [Composer & Input](./17-composer-input.md) | 队列简写、大粘贴、补全 provider 链、键位/重映射、渲染小项 |
| 19 | [Chat Sessions](./19-chat-sessions.md) | 无工具纯对话会话:SessionHeader.kind、--chat flag、类型隔离守卫、composer 裁剪、~2 天 | 12.6KB |
| 22 | [Felt Quality](./22-felt-quality.md) | 对话流畅、session 切换、色彩合同、动效尺、Chrome 去重 |
| 23 | [Scheduled Tasks](./23-scheduled-tasks.md) | Tasks from agent conversations: scheduler in main, headless run sidecars, structured reports, verification, review queue, insights |

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shell | Electron 35 (not Tauri) | No Rust constraint; full TS; mature ecosystem |
| Frontend | React 19 + Tailwind 4 | Stats dashboard compatibility; team familiarity |
| State | Zustand 5 | Minimal, event-driven, selector-based |
| Agent interface | `omp --mode rpc-ui` (stdio NDJSON) | Process isolation; hasUI=true enables approval + extension UI |
| Coupling | Pure sidecar, zero runtime imports | Never modifies or imports existing code |
| Session data | Read-only file access + RPC mutations | GUI never writes session files (except delete) |
| Build | electron-vite 3 | Fast HMR, TS-native, main/preload/renderer split |
| Packaging | electron-builder 26 | Cross-platform, signing, auto-update |

## Hard Constraints

1. No Rust — all TypeScript/JavaScript
2. No source modification — `packages/gui/` is purely additive
3. No runtime imports of `@oh-my-pi/*` packages
4. No writes to `~/.omp/` (except `~/.omp/gui/` prefs + session delete)
5. omp binary is the only backend
6. `--mode rpc-ui` (not `rpc`) — enables extension UI + approval

## v1 Limitations (Verified)

- Plan/Goal/Vibe/Loop modes: handleTui-only, unreachable via RPC
- Arbitrary settings get/set: no RPC command
- Theme switching: setTheme errors in RPC
- Retry last turn: no RPC command (workaround: re-prompt)
- Rich askDialog: absent from RPC UI context

## Quick Start

```bash
cd packages/gui
bun install
bun run dev          # Development with HMR (requires omp in PATH)
bun run build        # Production build → out/
bun run package      # Platform installers → dist/
```
