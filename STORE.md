# 上架 Microsoft Edge 应用商店

**结论**：可以上架，但提交必须由你在浏览器里完成——Edge 应用商店没有公开的上传 API，而且提交要在你的 Microsoft 账号下进行。

已经替你准备好的东西：

```
dist/ai-answer-helper-1.1.1.zip   # 直接上传的包（14 个文件，56 KB）
store/icon-300.png                # 商店列表图标 300×300
store/promo-440x280.png           # 小宣传图
store/promo-1400x560.png          # 大宣传图
docs/panel.png                    # 截图（需要 1280×800，见下文）
```

上传前先自检一遍包内容：

```bash
python tools/build-package.py          # 重新打包
bash tools/check-package.sh            # 解压后用真实浏览器加载验证
```

## 一、准备工作

1. **Microsoft 个人账号**（Outlook / Live / Hotmail，或用 GitHub 账号登录）。Edge 计划**不支持**用公司/学校账号（Entra ID）注册。
2. 登录 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/public/login)。
3. **注册 Edge 开发者计划**（免费）：
   - 打开 [Account settings → Programs](https://partner.microsoft.com/dashboard/account/v3/settings/programs)
   - 在 **Microsoft Edge** 卡片点 **Get started**
   - 表单里：国家/地区（注册后不可改）→ 账户类型选 **Individual**（个人，验证最快）→ 发布者显示名填 `ai-answer-helper` → 联系方式 → 勾选接受 App Developer Agreement → **Finish**
4. 等确认邮件。通过后回到 **Home**，**Workspaces** 区会出现 **Edge** 卡片——**没有这张卡就说明还没注册成功**。
5. 点 **Edge** 卡片 → **Overview** → **Create new extension**。

## 二、提交步骤

1. Partner Center → **Microsoft Edge** → **新建** → 上传 `dist/ai-answer-helper-1.1.1.zip`
2. 填写「属性」页（下面的文案可以直接复制）
3. 上传图标、截图、宣传图
4. 填写隐私政策与支持链接
5. 点「发布」→ 进入审核（通常 1–7 个工作日）
6. 审核通过后自动上架；被拒会给出原因，改完可重新提交

## 三、可以直接复制的文案

**名称（商店显示名）**

```
ai-answer-helper
```

**简短描述（≤132 字符）**

```
识别网页上的题目，调用你配置的 AI 接口给出答案与解析。支持 DeepSeek、OpenAI 等任意 OpenAI 兼容服务。
```

**详细描述**

```
ai-answer-helper 是一个学习辅助工具：在网页上看到不会做的题，点一下悬浮球或按 Alt+Q，
它会把题目读出来交给 AI，逐字显示答案、解析和每个选项的对错原因。

【主要功能】
· 一键识别：悬浮球 / Alt+Q / 工具栏图标三种呼出方式
· 题库结构识别：自动抓取题干与 A/B/C/D 选项，跨 iframe（如学习通）同样有效
· 题型判断：单选、多选、判断、填空、简答自动识别，认错了点一下标签就能改
· 流式作答：答案逐字出现，可随时停止
· 识别不准时：可手动框选题目、直接编辑文本，或截图交给视觉模型
· 一键复制答案

【支持的 AI 服务】
DeepSeek、OpenAI、通义千问、Kimi、智谱 GLM、硅基流动，以及任何 OpenAI 兼容接口
（包括本机运行的 Ollama）。接口地址、模型、提示词都可以自己改。

【隐私】
· 不需要注册，不收集任何使用数据，没有统计和埋点
· API Key 只保存在本机浏览器里
· 题目只会发送到你亲自填写的那个接口地址
· 完整说明：https://github.com/crane-you/ai-answer-helper/blob/main/PRIVACY.md

【说明】
本工具用于学习和核对答案，请遵守所访问网站的使用规则。
```

**类别**：`效率`（Productivity）。如果审核觉得偏教育，也可以换成 `教育`。

**隐私政策 URL**

```
https://github.com/crane-you/ai-answer-helper/blob/main/PRIVACY.md
```

**支持 / 主页 URL**

```
https://github.com/crane-you/ai-answer-helper
```

**语言**：至少勾选「中文（简体）」；建议同时添加 English。

## 四、权限说明（提交表单会要求解释）

| 权限 | 填写理由 |
| --- | --- |
| `host permissions: <all_urls>` | 用户可能在任何题库/作业网站上使用，扩展需要在当前页面注入识别悬浮球；同时该权限用于向用户自行填写的 AI 接口地址发起请求（地址由用户配置，无法预先枚举） |
| `scripting` | 扩展安装后，用户已经打开的页面需要补注入内容脚本，否则必须手动刷新才能使用 |
| `storage` | 在本机保存用户的接口配置与 API Key |

提交时记得勾选「不使用远程代码」——本扩展的所有逻辑都在安装包内，没有动态加载。

## 五、素材要求对照

| 素材 | 商店要求 | 我们提供的 |
| --- | --- | --- |
| 商店图标 | 300×300 PNG | `store/icon-300.png`（已生成） |
| 截图 | 1280×800 或 640×480，至少 1 张，最多 10 张 | 见下 |
| 小宣传图 | 440×280（可选） | `store/promo-440x280.png` |
| 大宣传图 | 1400×560（可选） | `store/promo-1400x560.png` |

截图需要单独出图，命令：

```bash
EDGE_PATH="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  bash tools/make-store-screenshots.sh
```

产物在 `store/shot-*.png`，均为 1280×800。

## 六、审核注意

1. **别把定位写成「考试神器」「自动答题」**。这类扩展在两个商店都被重点审查过，"代写作业"可能直接被拒。文案统一用「学习辅助 / 核对答案 / 解析思路」。
2. **悬浮球会自动出现在所有网页**，审核员可能问「为什么所有站点都能注入」。上面的权限理由已覆盖，必要时在回复里说明这是产品形态（用户随时可能在任意题库页面用到）。
3. **付费接口**：审核员通常没有 API Key。建议在提交备注里说明「未配置 Key 时面板会引导用户填写自己的 Key，不会自动发起请求」，避免他们以为功能不可用。
4. 保留 README 与 PRIVACY 里的免责声明。

## 七、以后更新版本

```bash
# 1. 改 manifest.json 的 version
# 2. 更新 CHANGELOG.md
python tools/build-package.py          # 重新打包
bash tools/check-package.sh            # 自检
# 3. Partner Center → 该扩展 → 更新 → 上传新 zip
```

Edge 商店要求每次更新的版本号必须大于已上架版本。