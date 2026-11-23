# GitHub Platform Branch and Version Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 EnvDock 的共享功能基线、GitHub 长期分支、平台版本标签和历史版本归档规则整理成清晰、可恢复的结构。

**Architecture:** `main` 作为共享源码和说明的唯一来源；`windows` 与 `macos` 作为平台发布分支；历史版本使用带平台后缀的 tag 和 GitHub Release 归档。临时 `codex/*` 分支只用于一次性工作，交付后删除。

**Tech Stack:** Git、Markdown、GitHub branches、Git tags、GitHub Releases。

**Spec:** `docs/platform-branch-and-version-policy.md`

## Global Constraints

- 长期分支只保留 `main`、`windows`、`macos`。
- 新平台 tag 必须使用 `v<X.Y.Z>-windows` 或 `v<X.Y.Z>-macos`。
- 历史 tag 和 Release 保留，不重写历史版本。
- 共享业务代码先进入 `main`，Windows `2.0.1` 已同步 macOS `2.0.0` 的共享能力；平台分支只维护平台适配、构建和发布。
- 交付包、数据库、真实接口数据、凭据和本机安装备份不提交到源码仓库。

---

### Task 1: Commit the repository policy

**Files:**
- Create: `docs/platform-branch-and-version-policy.md`
- Modify: `README.md`
- Create: `docs/superpowers/plans/2026-11-23-platform-branch-version.md`

**Interfaces:**
- Produces the canonical branch, version, tag, Release and archive rules for all platform branches.

- [x] **Step 1: Add the policy and README entry**

  Add the stable branch tree, platform responsibilities, version suffix rules, current version mapping, Release requirements and history retention rules.

- [ ] **Step 2: Check the documentation diff**

  Run:

  ```powershell
  git diff --check
  git diff -- README.md docs/platform-branch-and-version-policy.md docs/superpowers/plans/2026-11-23-platform-branch-version.md
  ```

  Expected: no whitespace errors and only the intended documentation changes.

- [ ] **Step 3: Commit the policy**

  Run:

  ```powershell
  git add README.md docs/platform-branch-and-version-policy.md docs/superpowers/plans/2026-11-23-platform-branch-version.md
  git commit -m "docs: define platform branches and version rules"
  ```

### Task 2: Synchronize Windows with macOS shared capabilities

**Files:**
- Shared React / TypeScript / Rust / test configuration
- Windows version metadata and release notes

**Interfaces:**
- Windows `2.0.1` provides the same shared workbench behavior as macOS `2.0.0`.
- Windows-specific DPAPI, WebView2, NSIS, PowerShell and local data paths remain unchanged.

- [x] **Step 1: Apply shared code and tests**
- [x] **Step 2: Keep macOS-only path and delivery changes out of Windows**
- [x] **Step 3: Upgrade Windows metadata to `2.0.1` and add `check:version`**
- [x] **Step 4: Run frontend, build, packaging and Rust verification**

### Task 3: Create stable local branches and platform tag

**Files:**
- Git ref: `windows`
- Git ref: `macos`
- Git tag: `v2.0.1-windows`

**Interfaces:**
- `windows` points to the documented Windows baseline.
- `macos` points to the existing macOS 2.0.0 release commit.
- `v2.0.0-macos` remains unchanged.

- [ ] **Step 1: Create `windows` from updated `main`**

  Run:

  ```powershell
  git branch windows main
  ```

- [ ] **Step 2: Rename the local macOS release branch**

  In `D:\专用工具\接口工具\macOS-2.0.0\开发空间`, run:

  ```powershell
  git branch -m macos
  ```

- [ ] **Step 3: Create the Windows platform tag**

  Run:

  ```powershell
  git tag -a v2.0.1-windows windows -m "EnvDock Windows 2.0.1"
  ```

- [ ] **Step 4: Verify local references**

  Run:

  ```powershell
  git show-ref --heads --tags
  git merge-base --is-ancestor main windows
  git rev-parse macos
  git rev-parse v2.0.0-macos
  ```

  Expected: `windows` contains updated `main`; `macos` and `v2.0.0-macos` resolve to the existing macOS release commit.

### Task 4: Synchronize the clear structure to GitHub

**Files:**
- Remote branch: `windows`
- Remote branch: `macos`
- Remote tag: `v2.0.1-windows`
- Remote cleanup: `codex/macos-2.0.0`

**Interfaces:**
- GitHub exposes `main`, `windows` and `macos` as the long-lived platform branches.
- Historical tags remain available.

- [ ] **Step 1: Push stable branches and tags**

  Run:

  ```powershell
  git push origin main windows
  git push origin macos v2.0.1-windows
  ```

- [ ] **Step 2: Remove the temporary remote branch**

  Run:

  ```powershell
  git push origin --delete codex/macos-2.0.0
  ```

- [ ] **Step 3: Verify the remote layout**

  Run:

  ```powershell
  git ls-remote --heads origin
  git ls-remote --tags origin "v2.0.1-windows"
  git ls-remote --tags origin "v2.0.0-macos"
  ```

  Expected: only the three stable branches are listed, both platform tags resolve, and the historical tags remain available.
