# Scene Image → ComfyUI

给 SillyTavern 的 **ComfyUI** 生图后端补一条「场景图 / 角色立绘」通道。

## 解决什么问题

SillyTavern 原生只有两条图片通道：

| 占位符 | 来源 | 局限 |
| --- | --- | --- |
| `%char_avatar%` | 角色卡头像 | 头像往往是卡面/风景/证件照，不一定是角色立绘 |
| `%user_avatar%` | 用户头像 | 同上 |

角色立绘、世界观场景图通常是**以 URL 插在消息正文里**的（`![](https://...)` 或 `<img src="...">`），ComfyUI 那侧拿不到 —— 浏览器缓存是 blob，ComfyUI 进程读不到；SillyTavern 也不给聊天外链图落盘。

本扩展在 `fetch` 层拦下 SillyTavern 发往 `/api/sd/comfy/generate` 的生图请求，把工作流里的 `"%scene_image%"` 替换成：

1. 聊天记录里**最新一张够大的图**（`.mes_text img`，边长 < `128` 的忽略）；
2. 抓不到 → 退回**角色卡头像**；
3. 再抓不到 → `1x1` 透明 PNG（保证 ComfyUI 不报错）。

不修改 SillyTavern 任何核心文件，不需要额外装 ComfyUI 节点，不需要图床。

## 安装

1. SillyTavern → Extensions → **Install extension**
2. 粘贴本仓库地址：

   ```
   https://github.com/LaoHuangLL/scene-image-comfy
   ```

3. 刷新页面，在 Extensions 面板里能看到 **Scene Image → ComfyUI**。

## 工作流改造

只改一个节点 —— 把接收参考图的那个 `easy loadImageBase64`（或任意图片输入节点）的 `base64_data`：

```json
"25": {
  "inputs": {
    "base64_data": "%scene_image%",
    "image_output": "Preview",
    "save_prefix": "ComfyUI"
  },
  "class_type": "easy loadImageBase64"
}
```

> ⚠️ 占位符要**连双引号一起写**：`"%scene_image%"`。SillyTavern 的替换是字符串级的 `replaceAll('"%scene_image%"', ...)`，裸写 `%scene_image%` 不会被替换，ComfyUI 会直接把字面量当图片解码而报错。

如果你之前用的是 `%char_avatar%`，把它换掉即可 —— 本扩展抓不到聊天图时会自动退回角色卡头像，所以行为只增不减。

## 使用

Extensions 面板里的开关：

- **启用** —— 总开关，关掉就完全不管生图请求。
- **优先用聊天图** —— 关掉则直接用角色卡头像（行为和原生 `%char_avatar%` 一致）。
- **控制台调试日志** —— 排查时看 `[scene-image-comfy]` 开头的输出。
- **最近抓取** —— 显示这次抓到的是哪张、多大，附带缩略图，方便确认没抓错。

## 注意

- 只对 **ComfyUI** 后端生效（`/api/sd/comfy/generate`）。AUTOMATIC1111 / SD WebUI 后端走 `/api/sd/generate`，不在拦截范围内。
- 抓图是「从后往前扫当前聊天 DOM」，所以**图必须已经显示在聊天里**（滚到过或加载过即可，`<img>` 节点在 DOM 里就行）。
- 图片 URL 若是第三方站点，浏览器可能因 CORS 拒绝 `fetch`。这种图会抓取失败并自动退回头像。同源图片（SillyTavern 自己的 `/characters/`、`/user/files/` 等）没有这个问题。
- FaceID 类节点（`IPAdapterUnifiedLoaderFaceID` + `buffalo_l`）只认真人脸，二次元立绘常常检测不到。建议只用 ACN Reference（`style_fidelity` / `ref_weight`）那条支路，或把 FaceID 节点 bypass。

## 许可

MIT
