# AI 机器人问答测试平台 —— API 契约

服务地址：`http://127.0.0.1:3789`

所有请求/响应均为 JSON（除下载与截图接口）。时间字段统一为 ISO 8601 字符串。

---

## 数据结构

### Project（项目）
```json
{
  "id": "p_1a2b3c",
  "name": "xxx大学图书馆AI馆员",
  "url": "https://robot.chaoxing.com/coze?accessToken=...",
  "questions": ["问题1", "问题2", "... 共10条"],
  "createdAt": "2026-09-20T16:30:00.000Z",
  "updatedAt": "2026-09-20T16:30:00.000Z",
  "runCount": 3,
  "lastRunAt": "2026-09-20T16:55:00.000Z"
}
```

### RunSummary（轮次摘要）
```json
{
  "id": "r_9f8e7d",
  "projectId": "p_1a2b3c",
  "index": 1,
  "status": "running | done | failed",
  "startedAt": "2026-09-20T16:40:00.000Z",
  "finishedAt": null,
  "total": 10,
  "okCount": 8,
  "avgSec": 16,
  "error": null
}
```

### Run（轮次完整数据）= RunSummary +```json
{
  "progress": {
    "current": 3,
    "total": 10,
    "question": "当前正在问的问题",
    "phase": "loading | newConversation | typing | waiting | done",
    "message": "等待回答中 12s"
  },
  "engine": {
    "inputSelector": ".input-body.ProseMirror",
    "sendSelector": ".send-button",
    "newConvSelector": ".add-conversation"
  },
  "results": [
    {
      "index": 1,
      "question": "图书馆的开放时间是怎样安排的？",
      "answer": "AI 回答全文……",
      "card": false,
      "elapsedSec": 18,
      "completed": true,
      "note": "",
      "flow": "检索过程文本",
      "recall": "知识库召回完成",
      "recallTitles": ["问题理解完成", "意图识别完成", "知识库召回完成"],
      "attribution": "该答案由AI大模型总结生成，内容来自：单位AI知识库",
      "source": {
        "category": "qa | unit | other",
        "label": "单位AI知识库",
        "raw": "该答案由AI大模型总结生成，内容来自：单位AI知识库",
        "reason": "署名或召回命中"
      },
      "hasScreenshot": true,
      "sendTime": "2026/9/20 16:41:00",
      "answerTime": "2026/9/20 16:41:18"
    }
  ]
}
```

---

## 接口

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/api/health` | 健康检查 | — | `{ok:true, chrome:"ready"\|"down", version:"1.0.0"}` |
| GET | `/api/state` | 项目列表 | — | `{projects:[Project], chrome:"ready"\|"down"}` |
| GET | `/api/question-bank` | 分类测试问题库 | — | 见下 |
| GET | `/api/ai/status` | AI 生成配置状态 | — | `{configured, keyMasked, baseUrl, model, source}` |
| POST | `/api/ai/config` | 保存 API Key / 模型配置 | `{apiKey?, baseUrl?, model?}` | 同 status |
| POST | `/api/ai/test` | 测试模型连通性 | — | `{ok, model?, reply?}` 或 `{ok:false, error}` |
| POST | `/api/ai/generate-questions` | AI 生成测试问题 | `{keyword, count?, existing?}` | `{questions:[...], model, usage}` |
| POST | `/api/projects` | 新建项目 | `{name, url, questions?}` | `Project` |
| GET | `/api/projects/:pid` | 项目详情 | — | `{project:Project, runs:[RunSummary]}` |
| PATCH | `/api/projects/:pid` | 修改项目 | `{name?, url?, questions?}` | `Project` |
| DELETE | `/api/projects/:pid` | 删除项目（含其所有轮次） | — | `{ok:true}` |
| POST | `/api/projects/:pid/runs` | 开始新一轮测试 | `{questions?}` 可选覆盖 | `{runId, index}` |
| GET | `/api/runs/:rid` | 轮次完整数据 | — | `Run` |
| DELETE | `/api/runs/:rid` | 删除轮次。**若该轮仍在运行，则改为「停止」并保留已完成结果** | — | `{ok:true, status:"deleted"｜"stopped"}` |
| POST | `/api/runs/:rid/pause` | 暂停本轮：当前题目跑完后停下 | — | `{ok:true, status:"paused"}` |
| POST | `/api/runs/:rid/resume` | 继续本轮 | — | `{ok:true, status:"running"}` |
| POST | `/api/runs/:rid/stop` | 停止本轮：立即结束，**已完成的结果与截图全部保留** | — | `{ok:true, status:"stopped", okCount}` |
| GET | `/api/runs/:rid/events` | **SSE** 实时进度 | — | 见下 |
| GET | `/api/runs/:rid/report.docx` | 下载本轮 Word 报告 | — | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| GET | `/api/projects/:pid/report.docx` | 下载项目**多轮汇总**报告 | — | 同上 |
| GET | `/api/runs/:rid/shot/:index` | 该题页面截图 | — | `image/png` |
| POST | `/api/chrome/restart` | 重启受控浏览器 | — | `{ok:true}` |

### 回答来源（`source`）

每题都会记录回答来源，取自页面上的署名行（`.origin-text`）与过程流召回标题（`.process-flow__title`）：

| `category` | 含义 | 判定依据（示例文案） | 报告中的颜色 |
|---|---|---|---|
| `qa` | 问答库 | `内容来自：问答库`、`问答库召回完成` | 蓝色 |
| `unit` | 单位知识库 | `内容来自：单位AI知识库`、`知识库召回完成` | 绿色 |
| `other` | 其他 | 仅 `该答案由AI大模型生成`（没有检索到任何库） | 红色 |

`label` 是页面声明的库名（如「单位AI知识库」），拿不到时由类别给默认名。
`raw` 保留页面原文，便于追溯。

### SSE 事件（`GET /api/runs/:rid/events`）
每条事件形如 `data: {JSON}\n\n`：

```json
{"type":"status",   "status":"running"}
{"type":"status",   "status":"paused"}
{"type":"progress", "progress":{"current":3,"total":10,"question":"...","phase":"waiting","message":"等待回答中 12s"}}
{"type":"result",   "result":{ ...单题结果对象... }}
{"type":"status",   "status":"done", "okCount":8, "avgSec":16}
{"type":"status",   "status":"stopped", "okCount":3, "error":"已手动停止"}
{"type":"status",   "status":"failed", "error":"错误信息"}
```

`status` 取值：`running`（运行中）、`paused`（已暂停）、`done`（已完成）、
`stopped`（已手动停止，结果保留）、`failed`（失败）。

### 暂停 / 停止的语义

- **暂停**在「题目之间」的安全点生效：当前题目会正常跑完并截图，之后不再开始下一题。
  这样不会打断正在生成的回答，也不会产生半截结果。
- **继续**从下一题接着跑，与本轮已完成的记录合并。
- **停止**立即结束本轮（正在生成的那一题可能没有结果），本轮标记为 `stopped`，
  已完成的结果与截图全部保留，可正常查看与下载报告。
- 暂停中的轮次仍占用该项目：需先「继续」或「停止」才能开始新一轮（否则返回 409）。
- 服务重启后，`paused` 的轮次在内存中的运行器已丢失，此时点「继续」会提示不可恢复，
  需点「停止」收尾或重新开始。

连接建立后会**立即补发**当前 `status` 与 `progress`，以及已完成的全部 `result`，便于中途刷新页面后恢复视图。

---

## 分类测试问题库

`GET /api/question-bank` 返回按业务模块组织的问题库，前端用它渲染勾选面板。
**项目里最终仍然只保存一个扁平的问题数组**，问题库只是便捷的填充来源。

```json
{
  "categories": [
    {
      "id": "borrow",
      "name": "借阅规则",
      "icon": "📚",
      "desc": "开馆时间、借阅与续借、超期与赔偿",
      "total": 17,
      "groups": [
        { "name": "开馆时间", "questions": ["图书馆的开放时间是怎样安排的？…"] },
        { "name": "借阅与续借", "questions": ["…"] },
        { "name": "超期与赔偿", "questions": ["…"] }
      ]
    }
  ],
  "total": 56,
  "defaults": ["新建项目时默认勾选的问题…"]
}
```

- `groups[].name` 为空字符串表示该类下不分小组。
- 问题库定义在 `lib/question-bank.js`，增删题目直接改这个文件即可，无需动前端。

---

## AI 生成测试问题

调用 DeepSeek（OpenAI 兼容接口）根据关键词生成测试问题。

### 配置来源（优先级从高到低）
1. 环境变量 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`
2. `data/settings.json`（通过 `POST /api/ai/config` 写入，页面上填写的密钥存这里）

### `POST /api/ai/generate-questions`
请求：
```json
{
  "keyword": "座位预约",
  "count": 5,
  "existing": ["已存在的问题，用于去重避免生成重复题"]
}
```
响应：
```json
{
  "questions": ["图书馆的自习座位需要预约吗？…", "…"],
  "model": "deepseek-chat",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

服务端会做这些清洗，保证返回的是干净的问句：去掉序号/项目符号、去掉首尾引号、过滤模型的开场白与客套话（如「以下是…：」「希望…」）、剔除空行与重复项、按 `count` 截断。

错误码：`400` 未配置密钥或关键词为空；`401` 密钥无效；`502` 连接失败/超时/返回不可解析。

---

## 错误格式
```json
{ "error": "人类可读的错误信息" }
```
HTTP 状态码：400 参数错误 / 404 不存在 / 409 该轮次正在运行或暂停中、或该轮次已结束无法暂停·继续·停止 / 500 服务器错误。
