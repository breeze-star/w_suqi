const $ = id => document.getElementById(id);
const images = { a: '', b: '' };
let version = 0;
const imageVersion = { a: 0, b: 0 };
let busy = false;

function update() {
  $('run').disabled = busy || !images.a || !images.b || !$('target').value.trim();
  $('run').textContent = busy ? '正在对比…' : '开始对比';
}
function clear() {
  $('change-boxes').replaceChildren();
  $('results').replaceChildren();
  $('raw').hidden = true;
  $('status').textContent = '图片或目标已更改，请重新开始对比。';
}
for (const key of ['a', 'b']) {
  $(`upload-${key}`).onclick = () => $(`file-${key}`).click();
  $(`file-${key}`).onchange = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      $('status').textContent = '请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片。';
      return;
    }
    ++version;
    const current = ++imageVersion[key];
    images[key] = '';
    clear();
    update();
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (current !== imageVersion[key]) { bitmap.close(); return; }
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      images[key] = canvas.toDataURL('image/jpeg', .9);
      $(`image-${key}`).src = images[key];
      $(`wrap-${key}`).hidden = false;
      $(`empty-${key}`).hidden = true;
      $(`name-${key}`).textContent = `${file.name} · ${canvas.width} × ${canvas.height}`;
    } catch { $('status').textContent = '无法读取图片，请选择有效的图片文件。'; }
    update();
  };
}
$('target').oninput = () => { version++; clear(); update(); };
$('change-form').onsubmit = async event => {
  event.preventDefault();
  if ($('run').disabled) return;
  const current = version;
  busy = true;
  clear();
  $('status').textContent = '正在对比两张图片…';
  update();
  try {
    const response = await fetch('/api/change', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageA: images.a, imageB: images.b, terms: [$('target').value.trim()] }) });
    const data = await response.json();
    if (current !== version) return;
    if (!response.ok) {
      if (data.raw) { $('raw').hidden = false; $('raw-text').textContent = data.raw; }
      throw new Error(data.error);
    }
    $('status').textContent = data.detections.length ? `发现 ${data.detections.length} 个疑似新增目标 · ${(data.elapsedMs / 1000).toFixed(1)} 秒` : '未发现可确认的新增目标。请结合图片人工复核。';
    data.detections.forEach(({ label, bbox_2d: [x1, y1, x2, y2] }) => {
      const box = document.createElement('div');
      box.className = 'box';
      box.style.cssText = `left:${x1 / 10}%;top:${y1 / 10}%;width:${(x2 - x1) / 10}%;height:${(y2 - y1) / 10}%;--mark:#c7ff6b`;
      const caption = document.createElement('span');
      caption.className = `box-label${y1 < 50 ? ' inside' : ''}`;
      caption.textContent = label;
      box.append(caption);
      $('change-boxes').append(box);
      const item = document.createElement('li');
      item.className = 'result-item';
      item.textContent = `${label} · [${[x1, y1, x2, y2].join(', ')}]`;
      $('results').append(item);
    });
  } catch (error) {
    if (current === version) $('status').textContent = error.message || '对比失败，请重试。';
  } finally { busy = false; update(); }
};
