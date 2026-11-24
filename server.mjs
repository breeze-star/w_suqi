import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const endpoint = process.env.QWEN_CHAT_COMPLETIONS_URL;
const model = process.env.QWEN_MODEL || 'qwen3.8-27b';
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST || '127.0.0.1';
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

function parseBoxes(raw, terms) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const boxes = JSON.parse(clean);
  if (!Array.isArray(boxes) || !boxes.every(item => {
    const box = item?.bbox_2d;
    return terms.includes(item?.label) && Array.isArray(box) && box.length === 4 &&
      box.every(n => Number.isFinite(n) && n >= 0 && n <= 1000) && box[0] < box[2] && box[1] < box[3];
  })) throw new Error('Invalid detections');
  return boxes.map(({ label, bbox_2d }) => ({ label, bbox_2d }));
}

async function detect(req, res, change = false) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    return json(res, 415, { error: '请求需使用 application/json。' });
  }
  if (!process.env.QWEN_API_KEY) return json(res, 503, { error: '请先在服务端配置 QWEN_API_KEY。' });
  if (!endpoint) return json(res, 503, { error: '请先在服务端配置 QWEN_CHAT_COMPLETIONS_URL。' });

  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > (change ? 30 : 15) * 1024 * 1024) {
      req.resume();
      return json(res, 413, { error: '图片请求太大，请选择较小的图片。' });
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
  const validImage = value => typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
  if ((change ? !validImage(imageA) || !validImage(imageB) : !validImage(image)) ||
      !Array.isArray(terms) || !terms.length || terms.length > 24 ||
      terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 80)) {
    return json(res, 400, { error: '请提供 JPG、PNG 或 WebP 图片和 1–24 个目标词，每项最多 80 个字符。' });
  }

  const prompt = change ? `比较图片 A（较早）和图片 B（较晚），判断图片 B 中是否出现图片 A 中没有的${terms[0]}。只标记确实可以从两张图判断为新增的目标，无法判断是否新增时不要标记。对于每个疑似新增目标，返回其在图片 B 上的矩形框。仅输出 JSON 数组，例如 [{"label":"${terms[0]}","bbox_2d":[100,200,400,600]}]。label 必须是 ${JSON.stringify(terms[0])}。bbox_2d 为图片 B 上归一化至 0–1000 的 [左, 上, 右, 下]。没有可确认的新增目标时输出 []。` : `请在图片中定位与以下任一类名或描述匹配的所有可见实例：${JSON.stringify(terms)}。
每个实例单独返回一个最贴合目标的矩形框，label 必须使用列表中的原始词语。不要推测画面外或未匹配的目标。
只输出 JSON 数组，例如 [{"label":"目标词","bbox_2d":[100,200,400,600]}]。
bbox_2d 是归一化至 0–1000 的 [左, 上, 右, 下]，原点在图片左上角。没有匹配实例则输出 []。`;
  const started = performance.now();
  const disconnect = new AbortController();
  res.once('close', () => disconnect.abort());
  const timeout = AbortSignal.timeout(120_000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([timeout, disconnect.signal]),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          ...(change ? [{ type: 'text', text: '图片 A，较早时间：' }, { type: 'image_url', image_url: { url: imageA } }, { type: 'text', text: '图片 B，较晚时间：' }, { type: 'image_url', image_url: { url: imageB } }] : [{ type: 'image_url', image_url: { url: image } }]),
          { type: 'text', text: prompt },
        ] }],
        temperature: 0,
        max_tokens: 4096,
        ...(process.env.QWEN_VLLM_DISABLE_THINKING === '1' && {
          chat_template_kwargs: { enable_thinking: false },
        }),
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = [401, 403].includes(response.status) ? '请检查服务端令牌。' : '请稍后重试。';
      return json(res, 502, { error: `模型接口返回 HTTP ${response.status}。${message}` });
    }
    const completion = await response.json();
    const choice = completion.choices?.[0];
    const raw = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const elapsedMs = Math.round(performance.now() - started);
    if (choice?.finish_reason === 'length') {
      return json(res, 502, { error: '模型输出达到长度上限，请减少目标词或目标数量。', raw, elapsedMs });
    }
    let detections;
    try {
      detections = parseBoxes(raw, terms);
    } catch {
      return json(res, 502, { error: '模型输出不符合检测框格式，可在 JSON 视图查看原文。', raw, elapsedMs });
    }
    return json(res, 200, { model, elapsedMs, detections });
  } catch {
    if (disconnect.signal.aborted) return;
    return json(res, timeout.aborted ? 504 : 502, {
      error: timeout.aborted ? '模型请求超时，请重试。' : '无法获得模型响应，请检查内网连接。',
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
