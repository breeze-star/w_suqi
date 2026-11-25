import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const endpoint = process.env.QWEN_CHAT_COMPLETIONS_URL;
const model = process.env.QWEN_MODEL || 'qwen3.8-27b';
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST || '127.0.0.1';
const detectionRules = new Map([
  ['道路坑洼', {
    presence: '画面里清楚看到可通行路面破损形成的独立凹坑，能直接分辨坑壁或坑底与周围路面的落差。仅有俯拍远处道路纹理、石子、阴影、裂纹或积水，无法确认凹陷，判断缺失。',
    locate: '每个可辨认的独立凹坑单独画框，贴合可见破损边缘。排除平整修补路面、井盖、减速带、标线和阴影。仅有积水且看不清坑洼边缘时跳过。',
  }],
  ['河道大面积植被', {
    presence: '画面里清楚看到低矮浮叶或水生植被成片占据实际河道水面，浮叶团块和水直接接触。农田、岸线上成行的树冠、岸边绿带、倒影和零散浮叶判断缺失。',
    locate: '沿两侧河岸确定实际水面边界，每片只框在水面内连续铺开的植被。排除沿岸树冠、草带及倒影，即使它们紧贴或遮住河岸。水和岸界看不清时跳过。',
  }],
  ['秸秆禁烧', {
    presence: '必须在画面内看到清晰的明火或发光余烬与可辨认秸秆、作物残茬直接接触。仅见烟、雾、焦痕或从画外进入的烟，即使背景是收割后农田，也判断缺失。',
    locate: '框住画面内直接接触秸秆的明火或发光余烬，以及紧接的秸秆。框贴地面的燃烧源，排除空中烟带、雾、焦痕和非农田烟源。',
  }],
]);
const buildingPrompt = `对比同一地点第一张 A 和第二张 B。请以道路、河岸、相邻建筑为参照配对同一个地块。只有一张图显示独立固定建筑，另一张图对应位置直接能看到空地或裸露地表时，才记录变化。两张图都有且能够一一对应的建筑全部排除，即使屋顶颜色、角度、尺寸或光照不同。不要把变化旁边仍存在的建筑列入。季节、植被、阴影、遮挡不算建筑变化。
对每个真实变化，先核实现场状态，再只输出包含 {"state_a":"building 或 ground","state_b":"building 或 ground","bbox_2d":[左,上,右,下]} 的 JSON 数组。a 表示输入第一张图、b 表示第二张。两个状态必须不同。框住有建筑的那一张图上可见的完整建筑，坐标归一化到 0–1000。没有可靠变化时输出 []。`;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/street.jpg', ['street.jpg', 'image/jpeg']],
  ['/change', ['change.html', 'text/html; charset=utf-8']],
  ['/change.js', ['change.js', 'text/javascript; charset=utf-8']],
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function validImage(value) {
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0].length !== value.length || match[2].length % 4 !== 0) return false;

  const header = Buffer.from(match[2].slice(0, 16), 'base64');
  if (match[1] === 'jpeg') return header.toString('hex', 0, 3) === 'ffd8ff';
  if (match[1] === 'png') return header.toString('hex', 0, 8) === '89504e470d0a1a0a';
  return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
}

function parseModelJSON(raw) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(clean);
}

function parseBoxes(raw, terms, building) {
  const text = raw.trim();
  const startsWithJSON = ['[', '{', '`'].includes(text[0]);
  const emptyAfterExplanation = building && !startsWithJSON && /\n[ \t]*\[\s*\]$/.test(text);
  const boxes = emptyAfterExplanation ? [] : parseModelJSON(text);
  if (!Array.isArray(boxes) || !boxes.every(item => {
    const box = item?.bbox_2d;
    const validLabel = building
      ? (item?.state_a === 'building' && item.state_b === 'ground') ||
        (item?.state_a === 'ground' && item.state_b === 'building')
      : terms.includes(item?.label);
    return validLabel && Array.isArray(box) && box.length === 4 &&
      box.every(n => Number.isFinite(n) && n >= 0 && n <= 1000) && box[0] < box[2] && box[1] < box[3];
  })) throw new Error('Invalid detections');
  if (building) return boxes.map(({ state_a, bbox_2d }) => {
    const removed = state_a === 'building';
    return {
      label: '建筑', type: removed ? 'removed' : 'added', image_role: removed ? 'a' : 'b', bbox_2d,
    };
  });
  return boxes.map(({ label, bbox_2d }) => ({ label, bbox_2d }));
}

async function complete(images, prompt, signal, maxTokens = 4096) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
      temperature: 0,
      max_tokens: maxTokens,
      ...(process.env.QWEN_DISABLE_THINKING === '1' && { enable_thinking: false }),
      ...(process.env.QWEN_VLLM_DISABLE_THINKING === '1' && {
        chat_template_kwargs: { enable_thinking: false },
      }),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const message = [401, 403].includes(response.status) ? '请检查服务端令牌。' : '请稍后重试。';
    return { error: `模型接口返回 HTTP ${response.status}。${message}` };
  }
  const completion = await response.json();
  const choice = completion.choices?.[0];
  const raw = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  if (choice?.finish_reason === 'length') {
    return { error: '模型输出达到长度上限，请减少目标词或目标数量。', raw };
  }
  return { raw };
}

function confirmedPresets(raw, presets) {
  const { present } = parseModelJSON(raw) ?? {};
  if (!Array.isArray(present) || !present.every(label => presets.includes(label))) {
    throw new Error('Invalid preset check output');
  }
  return new Set(present);
}

async function detect(req, res, change = false) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    req.resume();
    return json(res, 415, { error: '请求需使用 application/json。' });
  }

  const maxBytes = (change ? 30 : 15) * 1024 * 1024;
  const tooLarge = { error: '图片请求太大，请选择较小的图片。' };
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    return json(res, 413, tooLarge);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      req.resume();
      return json(res, 413, tooLarge);
    }
    chunks.push(chunk);
  }

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return json(res, 400, { error: '请求 JSON 无法解析。' });
  }
  const { image, imageA, imageB, terms } = input ?? {};
  const building = change && terms === undefined;
  if (change ? !validImage(imageA) || !validImage(imageB) : !validImage(image)) {
    return json(res, 400, { error: '请提供有效的 JPG、PNG 或 WebP 图片。' });
  }
  if (!building && (!Array.isArray(terms) || !terms.length || terms.length > 24 ||
      terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 80))) {
    return json(res, 400, { error: '请提供 1–24 个目标词，每项最多 80 个字符。' });
  }
  if (!process.env.QWEN_API_KEY) return json(res, 503, { error: '请先在服务端配置 QWEN_API_KEY。' });
  if (!endpoint) return json(res, 503, { error: '请先在服务端配置 QWEN_CHAT_COMPLETIONS_URL。' });

  const started = performance.now();
  const disconnect = new AbortController();
  res.once('close', () => disconnect.abort());
  const timeout = AbortSignal.timeout(120_000);
  const signal = AbortSignal.any([timeout, disconnect.signal]);
  const elapsedMs = () => Math.round(performance.now() - started);
  const images = change ? [
    { type: 'text', text: building ? '图 A（第一张）：' : '图片 A，较早时间：' },
    { type: 'image_url', image_url: { url: imageA } },
    { type: 'text', text: building ? '图 B（第二张）：' : '图片 B，较晚时间：' },
    { type: 'image_url', image_url: { url: imageB } },
  ] : [{ type: 'image_url', image_url: { url: image } }];

  try {
    let targets = terms;
    if (!change) {
      const presets = [...new Set(terms.map(term => term.trim()).filter(term => detectionRules.has(term)))];
      if (presets.length) {
        const criteria = presets.map(term => `${term}：${detectionRules.get(term).presence}`).join('\n');
        const confirmPrompt = `检查图中是否明确存在以下巡检目标 ${JSON.stringify(presets)}。\n${criteria}\n只根据肉眼能在画面内指出的清晰目标判定。输出 JSON 对象 {"present":["可确认存在的目标原文"]}。看不清边界、介质或根源时按缺失处理。完全没有确认目标时 present 为空数组。不要描述或定位。`;
        const confirmation = await complete(images, confirmPrompt, signal, 800);
        if (confirmation.error) return json(res, 502, { ...confirmation, elapsedMs: elapsedMs() });
        try {
          const confirmed = confirmedPresets(confirmation.raw, presets);
          targets = terms.filter(term => !detectionRules.has(term.trim()) || confirmed.has(term.trim()));
        } catch {
          return json(res, 502, { error: '模型输出不符合巡检目标确认格式。', raw: confirmation.raw, elapsedMs: elapsedMs() });
        }
        if (!targets.length) return json(res, 200, { model, elapsedMs: elapsedMs(), detections: [] });
      }
    }

    let prompt;
    if (building) {
      prompt = buildingPrompt;
    } else if (change) {
      prompt = `比较图片 A（较早）和图片 B（较晚），判断图片 B 中是否出现图片 A 中没有的目标 ${JSON.stringify(terms[0])}。仅报告清晰可辨的新增目标。只输出 JSON 数组，每项为 {"label":${JSON.stringify(terms[0])},"bbox_2d":[100,200,400,600]}。bbox_2d 是 B 图上归一化至 0–1000 的 [左,上,右,下]。没有可确认的新增目标时输出 []。`;
    } else {
      const rules = targets.flatMap(term => {
        const rule = detectionRules.get(term.trim());
        return rule ? [`${JSON.stringify(term)}：${rule.locate}`] : [];
      });
      prompt = `请在图片中定位与以下任一类名或描述匹配的所有可见实例：${JSON.stringify(targets)}。
${rules.join('\n')}
每个实例单独返回一个最贴合目标的矩形框，label 必须使用列表中的原始词语。不要推测画面外或未匹配的目标。
只输出 JSON 数组，例如 [{"label":"目标词","bbox_2d":[100,200,400,600]}]。
bbox_2d 是归一化至 0–1000 的 [左, 上, 右, 下]，原点在图片左上角。没有匹配实例则输出 []。`;
    }
    const result = await complete(images, prompt, signal);
    if (result.error) return json(res, 502, { ...result, elapsedMs: elapsedMs() });
    let detections;
    try {
      detections = parseBoxes(result.raw, targets, building);
    } catch {
      return json(res, 502, { error: '模型输出不符合检测框格式，可在 JSON 视图查看原文。', raw: result.raw, elapsedMs: elapsedMs() });
    }
    return json(res, 200, { model, elapsedMs: elapsedMs(), detections });
  } catch {
    if (disconnect.signal.aborted) return;
    return json(res, timeout.aborted ? 504 : 502, {
      error: timeout.aborted ? '模型请求超时，请重试。' : '无法获得模型响应，请检查服务端到模型接口的连接。',
    });
  }
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'POST' && path === '/api/detect') return await detect(req, res);
    if (req.method === 'POST' && path === '/api/change') return await detect(req, res, true);
    const asset = req.method === 'GET' && assets.get(path);
    if (!asset) return json(res, 404, { error: '未找到此路径。' });
    const [file, type] = asset;
    const content = await readFile(new URL(`./public/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch {
    if (!res.destroyed) json(res, 500, { error: '本地服务出错，请重试。' });
  }
}).listen(port, host, () => console.log(`http://${host}:${port}`));
