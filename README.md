# dsh-profile-bridge

> **一句话：让 DeepSeek Harness 桌面版用上你"已经装好插件的 profile"—— 点一下切换，随时一键还原。**
> **In one line: make the DeepSeek Harness Desktop app use the profile that already has your plugins — one click to switch, one click to revert.**

[English](#english) | 中文

**桌面版看不到你在别的 profile 里装的那些插件？**这个插件一个设置页、一次点击就解决，而且旧目录会自动备份、随时还原。

```
切换前：桌面版 → profiles/desktop（空）          ✗ 看不到你的插件
切换后：桌面版 → profiles/desktop → profiles/web ✓ 你装的插件全都在
```

## 它解决什么问题

Harness 的插件是**按 profile 隔离**的。桌面版把 profile 目录硬编码为 `<DSH_HOME>/profiles/desktop`（见 `@deepseek-ai/dsh-desktop` 的 `lib/main.js`：`profile: join(dshHome, "profiles", "desktop")`），并且**没有提供切换 profile 的设置项或命令行参数**。于是：

- 你在 `dsh web` 的 profile（通常是 `web`）里 `dsh plugin add` 装的一堆插件，桌面版完全看不到；
- 想在桌面版里用，只能逐个重装一遍，之后还要维护两套。

这个插件把那条唯一可行的路做成了 UI：**让 `profiles/desktop` 变成指向目标 profile 的目录链接**。桌面版本身不会清空既有 profile —— 它只在 profile 不存在时才写入默认清单，也不会动 pnpm 装的包和 `link:` 链接 —— 所以把目录接过去就能直接用。

## 安装

```sh
# 从 GitHub 安装（当前推荐，已实测可用）
dsh plugin --profile desktop add github:2NF/dsh-profile-bridge

# 或者本地目录（开发/离线）
dsh plugin --profile desktop add /绝对路径/dsh-profile-bridge

# npm 一行待发布后可用（本包尚未发布到 npm，现在执行会 404）
# dsh plugin --profile desktop add dsh-profile-bridge
```

装完刷新页面（或重启应用）：**设置 → 配置档案**。

> ⚠️ **用哪个工具装**：请用命令行 `dsh plugin`（或与 profile 的 `node_modules` **同一 pnpm 大版本**的工具）。
> 桌面版自带的插件管理器用的是它自己的 pnpm（本例 v11），如果 profile 是 pnpm v10 装的，会报
> `ERR_PNPM_UNEXPECTED_STORE` 并拒绝安装 —— 详见下方「已知问题」。

> 想让它在你切换之后仍然可用，就把本插件也装进你准备切换过去的那个 profile：
> `dsh plugin --profile web add github:2NF/dsh-profile-bridge`

### 安装方式二：本地链接（不动 pnpm）

如果桌面版和 profile 的 pnpm 大版本不一致（见下方"已知问题"），包管理器会拒绝安装。可以绕开它：

```powershell
# Windows：把插件目录链接进 profile 的 node_modules
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-profile-bridge" `
  -Target "D:\path\to\dsh-profile-bridge"
```

```sh
# macOS / Linux
ln -s /path/to/dsh-profile-bridge ~/.dsh/profiles/desktop/node_modules/dsh-profile-bridge
```

然后在 profile 的 `cordis.patch.yml` 末尾追加一行（这就是 bundle 声明）：

```yaml
- insert:
    - id: profile-bridge
      name: 'dsh-profile-bridge'
```

刷新页面（Host 半边需要重启应用）即可看到设置页。

## 使用

1. 打开 **设置 → 配置档案**，页面会列出 `$DSH_HOME/profiles` 下所有 profile，并标出当前正在用的那个。
2. 选中要用的 profile（例如 `web`），点 **使用它**。
3. 应用会在两秒内自动关闭、完成目录切换、再自动打开 —— 打开后就是你的插件集合。
4. 想回去就点 **还原为独立 profile**（会删除链接并把切换前的目录恢复回来）。

同页面还会显示：依赖数 / bundle 数 / `node_modules` 是否存在（切换前的体检）、上次操作日志、"工作原理"说明。

## 工作原理

切换必须在**应用关闭时**做：运行中的应用占着自己的 profile 目录，插件自己也跑在那个进程里。所以流程是：

```
点击「使用它」
   └─ Host 半边校验目标 profile，渲染一个平台脚本到 <DSH_HOME>/profile-bridge/
        └─ 以独立进程（detached）启动它 → 立即返回结果给页面
             └─ 脚本：等应用退出 → 改名备份 → 建 junction/symlink → 合并界面设置 → 重启应用
```

细节（都是踩过的坑）：

| 事项 | 做法 |
|---|---|
| 备份 | 应用 profile 改名为 `desktop.fresh-<时间戳>`，不删除 |
| 链接 | Windows 用目录 junction（`New-Item -ItemType Junction`），macOS/Linux 用 `ln -s` |
| 二次切换 | 已经是链接时直接删除旧链接再建新的，不会叠加备份 |
| 失败回滚 | 建链接后立刻校验目标 `package.json` 可读；失败就删链接、把备份改回来 |
| 界面设置 | 把桌面版首次运行写入的 `ui-chat` / `ui-settings` / `ui-settings-account` 三行并入目标 profile 的 `cordis.patch.yml`，避免重启后又走一遍引导（原文件备份为 `.bak-<时间戳>`） |
| 日志 | `<DSH_HOME>/profile-bridge/last-run.log`，页面内可查看 |
| 安全 | 脚本永不 `rm -rf`：删除链接用 `rmdir`/`rm -f`（只删链接本身），其余一律"改名" |

## 限制与注意事项

- **切换需要关闭应用**，这是操作系统的目录占用限制，不是插件的选择。脚本会自动完成关闭+重启；如果你想自己控制，可以用 `skipAppStop`/`noRelaunch` 参数调用 `link`/`unlink` 端点（测试模式），脚本会等你手动重启。
- **不要同时运行**桌面版和命令行 `dsh --profile <同一个 profile>`：两个进程共享同一份 `node_modules` 与锁文件。
- macOS / Linux 走符号链接路径，逻辑与 Windows 相同，但**未在真机验证**（欢迎反馈 Issue / PR）。
- 只有**桌面版**需要这个链接。命令行用户直接 `dsh --profile <名称>` 就好，本页会提示这一点并且不提供按钮。
- 若目标 profile 里没有安装本插件，切换过去之后这个设置页就不在了（插件属于 profile）。按上面"安装"一节的提示两边都装即可。

## 已知问题（都是实测踩到的）

**1. pnpm 大版本 / store 不一致**

桌面版自带 **pnpm v11**（用自己的 store），而 `dsh web`（CLI）侧的 profile 常见是 **pnpm v10** 装的（store v10）。链接之后，桌面版的插件管理器再安装任何插件都会失败：

```
[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location
The dependencies at "...\profiles\web\node_modules" are currently linked from the store at "...\pnpm\store\v10".
pnpm now wants to use the store at "...\pnpm\store\v11" ...
```

三种解法，任选其一：

| 解法 | 做法 | 代价 |
|---|---|---|
| 用 CLI 装 | `dsh plugin --profile desktop add <包名>`（用与 profile 一致的 pnpm） | 需要 CLI 的 pnpm 与 profile 匹配 |
| 本地链接 | 见上面"安装方式二" | 不经过包管理器，桌面版插件页看不到它的依赖行 |
| 对齐 store | 用桌面版的 pnpm 在该 profile 里跑一次 `pnpm install` | 会整体重新链接 node_modules，耗时且可能影响正在运行的应用 |

**2. `connection.rpc.handle()` 在部分版本不可用**

它需要访问 Connection 服务自己的 `webServer`，在某些版本上会抛 `cannot get property without inject`。本插件**先尝试官方通道，失败就自动降级**为自建的同协议路由（`/profile-bridge`，仅接受本机 loopback 访问，信封与官方 `client-request` / `server-response` 一致），所以浏览器半边无需改动。

**3. Windows 上不能用 `detached` 直接启动 `powershell.exe`**

实测（Node 24 + Windows）：`spawn('powershell.exe', …, { detached: true, stdio: 'ignore' })` 的进程**会创建但从不执行**（没有日志、没有副作用，看起来像"点了没反应"）；而 `detached` 启动 `cmd.exe` 完全正常，且子进程能在父进程被强杀后继续运行。

所以插件在 Windows 上生成两个文件、用 `cmd.exe` 中转：

| 文件 | 作用 |
|---|---|
| `<DSH_HOME>/profile-bridge/switch.ps1` | 真正干活的脚本（**带 UTF-8 BOM**，否则 Windows PowerShell 会把非 ASCII 路径读成乱码） |
| `<DSH_HOME>/profile-bridge/run.cmd` | 一行包装：`powershell.exe … -File switch.ps1 > last-run.log.out 2>&1`，由插件以 detached 方式启动 |

排错时看两个日志：`last-run.log`（脚本的结构化日志）和 **`last-run.log.out`**（PowerShell 自身的输出——脚本连第一行都没跑到时，原因在这里）。设置页的「上次操作日志」会自动显示有内容的那个。

**4. helper 的工作目录会锁住它自己要改名的目录**

桌面版启动宿主时用的是 **`cwd = profile 目录`**（`@deepseek-ai/dsh-desktop` 的 `main.js`：`cwd: this.projectDir`）。插件 spawn 出去的 helper 会继承这个工作目录，于是出现最反直觉的一种失败：**应用已完全退出、目录里没有任何别的进程，改名依然报 `still locked`** —— 因为 helper 自己就站在那个目录里，持有它的句柄。

三重防护：

| 位置 | 做法 |
|---|---|
| `lib/helper.mjs` | spawn 时显式指定 `cwd` 为插件状态目录（`<DSH_HOME>/profile-bridge`） |
| `run.cmd` | 第一行 `cd /d "%~dp0"`，先离开继承来的目录 |
| `switch.ps1` / `switch.sh` | 开头 `Set-Location $env:TEMP` / `cd /`，并把启动时的 `cwd=` 写进日志 |

失败时脚本还会列出**仍提到该路径的进程**（`rename blocked by: …`），并且无论成功失败都会把应用重新拉起来。自检里加了回归用例：**故意把工作目录设为 profile 目录**，再执行真实包装脚本，必须仍然切换成功。

**5. "切换成功，但应用没有自动回来"**

helper 本来就会重启应用，但 **Electron 的单实例锁**在退出瞬间仍可能被旧实例持有：新实例会把启动请求转交给那个正在退出的进程，然后自己退出 —— 表现出来就是"应用没回来"。现在：

| 措施 | 说明 |
|---|---|
| 退出后等待 | `Stop-App` 杀完进程后**再等 2 秒**，给单实例锁释放留时间 |
| 记录真实路径 | 从**正在运行的应用进程**里取可执行文件路径（不再依赖事先猜测的路径） |
| 多次重试 | `Relaunch-App` 最多启动 3 次，每次**等待窗口真正出现**（最长 20 秒） |
| 带到前台 | 窗口出现后用 `ShowWindow` + `SetForegroundWindow` 把它**提到最前** |
| 明确失败 | 三次都没起来就写"请手动启动应用"，不静默失败 |

**6. "什么都对了，就是应用不会自动回来"** ← 真正的元凶

Harness 的宿主进程是**以 Node 模式运行的 Electron**（`ELECTRON_RUN_AS_NODE=1` —— 这正是它让 Electron 当 Node 跑的方式），helper 继承了这个环境变量。于是 helper 再启动 `DeepSeek Harness.exe` 时，Electron **又变成无窗口的 Node 进程**：进程确实起来了、几秒后自己退出，界面永远不出现。而你手动双击图标时资源管理器给的是干净环境，所以一切正常 —— 现象看起来就像"只有插件不会重开"。

修复（v0.1.4）：重启应用前先清掉 `ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ATTACH_CONSOLE`、`ELECTRON_FORCE_IS_PACKAGED`、`NODE_OPTIONS`、`DSH_DESKTOP_NODE_EXECUTABLE`，再用 **`Start-Process -UseNewEnvironment`**（全新环境，等价于从开始菜单打开）启动；macOS/Linux 脚本同样 `unset` 这些变量。

## 手动回滚（不依赖本插件）

```powershell
# Windows：删链接 + 恢复备份
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop"
Rename-Item "$env:USERPROFILE\.dsh\profiles\desktop.fresh-<时间戳>" desktop
```

```sh
# macOS / Linux
rm ~/.dsh/profiles/desktop
mv ~/.dsh/profiles/desktop.fresh-<时间戳> ~/.dsh/profiles/desktop
```

## 开发与验证

```sh
node verify/precheck.mjs
```

这个脚本会在系统临时目录里造一棵假的 `profiles` 树，然后**真的执行一次 helper**：改名备份、建 junction、合并 patch、重指向、还原，并断言每一步的结果。运行时使用 `skipAppStop` + `noRelaunch`，**不会碰你正在运行的应用**。

仓库结构：

| 文件 | 说明 |
|---|---|
| `index.js` | Host 半边：共享 RPC 通道 `/profile-bridge`，端点 `status` / `link` / `unlink` |
| `lib/state.mjs` | profile 发现与校验（只读），状态载荷，日志尾读 |
| `lib/helper.mjs` | 渲染平台脚本、写入、detached 启动 |
| `lib/switch.windows.ps1.txt` | Windows 脚本模板（junction） |
| `lib/switch.posix.sh.txt` | macOS/Linux 脚本模板（symlink） |
| `client.js` | 浏览器半边：`settings.section` 设置页 |
| `verify/precheck.mjs` | 沙盒端到端自检 |

## License

MIT

---

<a id="english"></a>
# English

Make the **DeepSeek Harness Desktop app** use a profile that **already has your plugins**, instead of the empty profile it creates for itself. One settings page, one click, fully reversible.

## The problem

Plugins are scoped per profile, and the Desktop app hardcodes its profile directory to `<DSH_HOME>/profiles/desktop` (`@deepseek-ai/dsh-desktop`, `lib/main.js`: `profile: join(dshHome, "profiles", "desktop")`) with **no setting or flag to choose another one**. Everything you installed into your `dsh web` profile is therefore invisible to it, and the only workaround used to be reinstalling every plugin and maintaining two sets.

The Desktop app does not reset an existing profile — it only writes a default manifest when the directory is absent, and it never touches pnpm packages or `link:` dependencies — so linking the directory is enough.

## Install

```sh
# from GitHub (recommended today; verified end to end)
dsh plugin --profile desktop add github:2NF/dsh-profile-bridge
# or a local checkout
dsh plugin --profile desktop add /absolute/path/to/dsh-profile-bridge
# the npm line works once the package is published (not published yet)
```

Open **Settings → Profiles**, pick the profile you want, press **Use this one**. The app closes itself, the switch happens, and it reopens with your plugins. **Revert to a standalone profile** undoes it.

> Use the `dsh plugin` CLI (or any tool whose pnpm major matches the profile's
> `node_modules`). The Desktop app's own plugin manager uses its bundle pnpm (v11
> here) and refuses to install into a v10-managed profile with
> `ERR_PNPM_UNEXPECTED_STORE` — see Known issues below.

## How it works

The switch must happen while the app is closed (it holds its own profile directory, and this plugin runs inside that process), so the Host half renders a small platform script, launches it detached, and returns immediately. The script waits for the app to exit, renames the old directory to `desktop.fresh-<stamp>`, creates a junction (Windows) or symlink (macOS/Linux), merges the Desktop UI/onboarding rows into the target profile's `cordis.patch.yml`, and relaunches the app. Failures roll back. Nothing is ever deleted recursively — the link is the only thing removed, everything else is renamed. Logs land in `<DSH_HOME>/profile-bridge/last-run.log` and are shown in the page.

## Limits

- The switch closes the app by design; the helper does it for you.
- Do not run the Desktop app and `dsh --profile <same profile>` at the same time.
- macOS/Linux use the symlink path; the same logic, but **not verified on real hardware** yet.
- The plugin lives in a profile, so install it in both profiles if you want the page after switching.
- **Windows launch detail (measured):** `spawn('powershell.exe', …, { detached: true })` creates a process that never runs, so the helper is started as a detached `cmd.exe` running `run.cmd`, which invokes PowerShell with its output redirected to `last-run.log.out`. When the panel shows no log, that transcript is where the reason is.
- **The helper must not inherit the profile directory as its working directory.** The Desktop app starts its Host with `cwd` set to the profile directory, and a process whose working directory *is* a directory blocks renaming it — the helper would lock its own target and fail with "still locked" even after the app is gone. The launcher sets `cwd` to the plugin state directory, `run.cmd` starts with `cd /d "%~dp0"`, and the script leaves for `$env:TEMP`; the regression test runs the real wrapper from inside the profile directory.
- **Relaunch robustness:** Electron's single-instance lock can still be held while the old instance exits, so the helper waits for it, remembers the executable path taken from the running app, retries the launch up to three times while waiting for a real window, and brings that window to the front.
- **A relaunch needs a clean environment.** The Host runs the Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), and a helper that inherits that variable starts a window-less Node process instead of the app: the process appears, quits, and the app never comes back — while starting it by hand from Explorer works. The helper clears those variables and starts the app with `Start-Process -UseNewEnvironment`.

## Verify

`node verify/precheck.mjs` builds a throwaway profiles tree and really performs a switch, a re-point and a revert in it (with app stop/relaunch disabled, so nothing of yours is touched).

MIT licensed.
