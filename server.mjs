import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const endpoint = process.env.QWEN_CHAT_COMPLETIONS_URL;
const model = process.env.QWEN_MODEL || 'qwen3.8-27b';
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST || '127.0.0.1';
const roadCrackRule = {
  presence: '先定位可通行的沥青或水泥铺装路面，再确认裂缝实际切开该路面的铺装材料。同一条裂缝两侧应能看出相连的铺装表面，并能分辨开裂边缘或局部破损。近景可由清晰的铺装纹理确认路面。航拍画面只有少量路面时也只检查该铺装区域。田垄、耕作条纹、车辙、田埂、地块边界、排水沟、裸土开裂、道路边沿、阴影、标线及完整的规则接缝均排除。已有红框和界面标注不构成证据。无法明确裂缝位于铺装内部时判断缺失。',
  locate: '在已经确认的沥青或水泥铺装内部定位实际破损裂口。连通或分叉的同一裂缝只框一次，互不相连的裂缝分别输出。即使画面里另有道路，也排除农田或裸土上的黑线、灌溉渠、田埂、路肩边界、标线、阴影及平整接缝。不要跨出铺装区域追踪线条。看不清铺装破损的局部时跳过。',
};
const detectionRules = new Map([
  ['道路裂缝', roadCrackRule],
  ['路面裂缝', roadCrackRule],
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
const minimumSharedCoverage = 75;
const buildingPrompt = `对比第一张 A 和第二张 B 的建筑变化。依次完成下面三步，只输出一个 JSON 对象。
1. 先核对取景范围。分别估计两张完整图片中在对方图里也能定位到的场景面积百分比 coverage_a 和 coverage_b，填写 0 到 100 的整数。比较画面中央及四个象限的固定参照，包括道路与地块的相对位置、相邻建筑、河道和地块边界。大幅裁剪、变焦、转向和地块出画会降低覆盖率。若 B 只拍到了 A 右上方约四分之一，A 的覆盖率约 25，即便 B 的覆盖率接近 100。两图都有道路或草地无法证明它们是同一范围，找不到对应区域时填 0。
2. 两图覆盖率都至少 ${minimumSharedCoverage}，且主要地块在两图中清晰可见并能可靠配对时，填写 comparable 为 true。主要地块出画、显著失焦、遮挡、固定参照不足或看不准则填写 false。季节和光照差异本身不影响可比性。
3. 只有可比时才定位。只报告独立固定建筑与清晰可见的空地或裸露地表之间的变化。两张图都有且能一一对应的建筑全部排除。排除视野外、遮挡、阴影和植被变化。疑似变化的主要地块在任一图无法核实时，填写 comparable 为 false。
输出格式 {"coverage_a":95,"coverage_b":98,"comparable":true,"detections":[{"state_a":"ground","state_b":"building","bbox_2d":[100,200,400,600]}]}，示例数值须替换为本次判断。不可比或可比但无可靠变化时 detections 为 []。每个变化中 a、b 状态分别使用 building 或 ground，且必须不同。框住有建筑的那张图上的完整建筑，坐标按 [左,上,右,下] 归一化到 0–1000。不要输出解释。`;
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

function validateBoxes(boxes, terms, building) {
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

function comparisonImages(imageA, imageB, building) {
  return [
    { type: 'text', text: building ? '图 A（第一张）：' : '图片 A，较早时间：' },
    { type: 'image_url', image_url: { url: imageA } },
    { type: 'text', text: building ? '图 B（第二张）：' : '图片 B，较晚时间：' },
    { type: 'image_url', image_url: { url: imageB } },
  ];
}

function parseBuildingComparison(raw) {
  const { coverage_a, coverage_b, comparable, detections } = parseModelJSON(raw) ?? {};
  if (typeof comparable !== 'boolean' || !Array.isArray(detections) || (!comparable && detections.length) ||
      ![coverage_a, coverage_b].every(value => Number.isInteger(value) && value >= 0 && value <= 100)) {
    throw new Error('Invalid comparison status');
  }
  return { comparable: comparable && Math.min(coverage_a, coverage_b) >= minimumSharedCoverage, detections };
}

function boxesFromRows(parsed, targets) {
  const rows = parsed?.detections;
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) {
    throw new Error('Invalid detection rows');
  }
  return rows.map(row => {
    if (targets.length === 1 && row.length === 4 && row.every(Number.isFinite)) {
      return { label: targets[0], bbox_2d: row };
    }
    const [label, ...coordinates] = row;
    return { label, bbox_2d: coordinates.length === 1 ? coordinates[0] : coordinates };
  });
}

async function complete(images, prompt, signal, maxTokens = 4096, jsonObject = false) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
      temperature: 0,
      max_tokens: maxTokens,
      ...(jsonObject && { response_format: { type: 'json_object' } }),
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

async function verifyCrackBoxes(images, detections, signal) {
  const candidates = detections.filter(item => detectionRules.get(item.label.trim()) === roadCrackRule);
  if (!candidates.length) return { detections };
  const regions = candidates.map(({ bbox_2d }, index) => ({ index, bbox_2d }));
  const prompt = `复核每个候选框的实际地表。候选框只是待核查位置，不代表真的有道路裂缝。框为归一化至 0–1000 的 [左,上,右,下]，原点为图像左上角。候选列表 ${JSON.stringify(regions)}。
先沿画面实际边界区分沥青或水泥铺装和田地、裸土、沟渠，再逐框检查。屏幕上的红色描边和标注完全忽略。即使图像角落有道路，也必须在候选框里面看到线条实际切开连续的铺装表面。若候选主体在田里、线条顺着犁沟、田埂、车辙、渠边或路肩，或看不清线两侧的铺装破损，则排除该框。只输出 JSON 对象，例如仅编号 0 通过时输出 {"confirmed":[0]}。全都无法确认时输出 {"confirmed":[]}。不要输出解释。`;
  const result = await complete(images, prompt, signal, 800, true);
  if (result.error) return result;
  try {
    const fenced = /(?:^|\n)```json[ \t]*\r?\n([\s\S]+?)\r?\n```\s*$/i.exec(result.raw);
    const { confirmed } = parseModelJSON(fenced?.[1] ?? result.raw) ?? {};
    if (!Array.isArray(confirmed) || !confirmed.every(index => Number.isInteger(index) && index >= 0 && index < candidates.length)) {
      throw new Error('Invalid crack verification');
    }
    const approved = new Set(confirmed);
    const rejected = new Set(candidates.filter((_, index) => !approved.has(index)));
    return { detections: detections.filter(item => !rejected.has(item)) };
  } catch {
    return { error: '模型输出不符合道路裂缝复核格式。', raw: result.raw };
  }
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
  const images = change ? comparisonImages(imageA, imageB, building) : [{ type: 'image_url', image_url: { url: image } }];

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

    const crackRows = !change && targets.some(term => detectionRules.get(term.trim()) === roadCrackRule);
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
      const format = crackRows
        ? `只输出一个 JSON 对象。detections 内每行对应一个实例，坐标为归一化至 0–1000 的 [左,上,右,下]。${targets.length === 1
          ? '本次目标只有一类，每行只填坐标，如 {"detections":[[100,200,400,600]]}。'
          : `每行按 [目标词,[左,上,右,下]] 排列，目标词使用列表原词，如 {"detections":[[${JSON.stringify(targets[0])},[100,200,400,600]]]}。`} 无匹配时输出 {"detections":[]}。`
        : `每个实例单独返回一个最贴合目标的矩形框，label 必须使用列表中的原始词语。不要推测画面外或未匹配的目标。
只输出 JSON 数组，例如 [{"label":"目标词","bbox_2d":[100,200,400,600]}]。
bbox_2d 是归一化至 0–1000 的 [左, 上, 右, 下]，原点在图片左上角。没有匹配实例则输出 []。`;
      prompt = `请在图片中定位与以下任一类名或描述匹配的所有可见实例：${JSON.stringify(targets)}。
${rules.join('\n')}
${format}`;
    }
    const comparisons = [complete(images, prompt, signal, 4096, crackRows)];
    if (building) comparisons.push(complete(comparisonImages(imageB, imageA, true), prompt, signal));
    const results = await Promise.all(comparisons);
    const failure = results.find(result => result.error);
    if (failure) return json(res, 502, { ...failure, elapsedMs: elapsedMs() });
    let raw = results[0].raw;
    let detections;
    try {
      if (building) {
        const first = parseBuildingComparison(raw);
        raw = results[1].raw;
        const second = parseBuildingComparison(raw);
        // A narrower photo can make the wider view look like an addition when the image order is reversed.
        if (!first.comparable || !second.comparable) {
          return json(res, 422, {
            errorCode: 'IMAGES_NOT_COMPARABLE',
            error: '两张照片无法可靠比较，请核对拍摄点位、视角和画面清晰度。',
            comparable: false,
            elapsedMs: elapsedMs(),
          });
        }
        raw = results[0].raw;
        const boxes = validateBoxes(first.detections, undefined, true);
        return json(res, 200, { model, elapsedMs: elapsedMs(), comparable: true, detections: boxes });
      }
      const parsed = parseModelJSON(raw);
      detections = validateBoxes(crackRows ? boxesFromRows(parsed, targets) : parsed, targets, false);
    } catch {
      const error = building ? '模型输出缺少有效的可比性结论或检测框。' : '模型输出不符合检测框格式，可在 JSON 视图查看原文。';
      return json(res, 502, { error, raw, elapsedMs: elapsedMs() });
    }
    if (crackRows) {
      const verification = await verifyCrackBoxes(images, detections, signal);
      if (verification.error) return json(res, 502, { ...verification, elapsedMs: elapsedMs() });
      detections = verification.detections;
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
