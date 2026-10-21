# 接口来源记录

核对日期：2026-10-21。这里记录来源和验证范围，不把第三方实现视为官方 API 保证。

| 功能 | 本仓库依据 | 可确认的范围 |
| --- | --- | --- |
| 登录、手机号及 OAuth 流程 | 首次开源提交 `21f2d91`；`protocol-login.mjs` 保留 `HAR_ADD_PHONE_COOKIE_NAMES` 和 `missing vs HAR` 检查 | 可确认实现曾对照浏览器 HAR；仓库未保留足以追溯每一个接口的原始抓包和来源说明 |
| 首次设置 2FA | `42fb94e`（2026-08-10）引入状态查询、注册和激活流程 | 原有实现会跳过已启用 2FA 的账号，本身不包含关闭旧 2FA 的步骤 |
| 修改密码 | `password-set.mjs` 引用的两个第三方 Python 项目 | 属于第三方协议实现，不是稳定的公开接口文档 |
| 登出所有设备 | `account-security.mjs` 引用 ChatGPT 历史前端存档 | 能证明历史客户端曾使用该调用，不能直接证明当前版本兼容 |
| 更换 2FA | 本次新增；关闭步骤现参考 2026-09-27 的 `chatgpt-tool` 实现 | 按当前 TOTP 验证器 ID 关闭，再绑定新密钥；本地验证通过，线上尚待核实 |

## 本次 GitHub 核对

- [any-auto-register / two_factor.py](https://github.com/zc-zhangchen/any-auto-register/blob/6794821cbd3141c925e192c2a779d1365814fee4/platforms/chatgpt/protocol/two_factor.py)：该文件最后更新于 2026-08-21。实现查询、注册和激活；已经绑定时返回 `already_bound`，没有关闭步骤。
- [Standalone 2FA Workbench / twofa_bind.py](https://github.com/asdddd111/chatgpt-2fa-standalone-workbench/blob/5ba7f8e9b2695778a9f58e53780866aaa0794875/twofa_bind.py)：提交日期为 2026-08-20。提供注册和激活功能，不能据此推断关闭接口。
- [chatgpt-tool / mfa_phase.py](https://github.com/quyetlv12/chatgpt-tool/blob/4d0d1201bf0d837fa58e5bca64d72cec11f57ac0/modules/twofa/mfa_phase.py#L594-L676)：提交日期为 2026-09-27，包含关闭当前 TOTP 验证器后重新启用的流程。该文件也注明其绑定流程参考 HAR。
- [ChatGPT 历史前端存档](https://github.com/0xdevalias/chatgpt-source-watch/blob/88970f48f28e18a41341e446374f9727187dff08/unpacked/_next/static/chunks/pages/_app.js)：该路径最后更新于 2024-04-26。此前参考其中的关闭调用，但本次实际账号返回 HTTP 405，已不再使用这个调用。

## 当前验证边界

- 用户提供的实际日志已经确认：密码验证、原 2FA 验证和会话获取成功，历史关闭请求返回 HTTP 405。
- 新关闭调用来自较新的第三方源码，尚未在真实账号上验证。程序仍需平台明确确认旧 2FA 已关闭，才会进入绑定步骤。
- 本地测试覆盖：从当前账号状态读取唯一 TOTP ID、缺失或多个 ID 时停止、关闭返回 204、关闭返回 200 但状态未变化、404/405 停止、不回退旧接口，以及新密钥保存、取消和重启恢复。
- 未复制第三方实现中的敏感信息日志和关闭请求自动重试行为；状态查询不作为绕过身份验证的依据。
