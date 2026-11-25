const $ = id => document.getElementById(id);
const colors = ['#c7ff6b', '#83d8ff', '#ffb78a', '#f7a6d9', '#d5bcff', '#ffe07a'];
let imageData = '';
let detections = [];
let responseData = null;
let selected = -1;
let busy = false;
let generation = 0;

function terms() {
  return [...new Set($('terms').value.split(/[,，;；\n]+/).map(t => t.trim()).filter(Boolean))];
}
function updateControls() {
  const items = terms();
  const valid = items.length > 0 && items.length <= 24 && items.every(t => t.length <= 80);
  $('term-count').textContent = `${items.length} / 24`;
  document.querySelector('.input-note').classList.toggle('invalid', !valid);
  $('detect').disabled = busy || !imageData || !valid;
  $('detect').classList.toggle('running', busy);
  $('detect').querySelector('span').textContent = busy ? '检测中…' : '开始检测';
}
function clearResult() {
  detections = [];
  responseData = null;
  selected = -1;
  $('result-status').hidden = true;
  $('result-empty').hidden = false;
  $('result-list').replaceChildren();
  $('boxes').replaceChildren();
  renderView();
}
function renderView() {
  const json = $('view-json').getAttribute('aria-pressed') === 'true';
  $('result-list').hidden = json || !detections.length;
  $('result-empty').hidden = json || responseData !== null;
  $('json-view').hidden = !json;
  $('json-output').textContent = responseData ? JSON.stringify(responseData, null, 2) : '运行检测后显示结果';
  $('copy').disabled = !responseData;
}
function renderResults() {
  $('boxes').replaceChildren();
  $('result-list').replaceChildren();
  detections.forEach((item, index) => {
    const [x1, y1, x2, y2] = item.bbox_2d;
    const color = colors[index % colors.length];
    const box = document.createElement('div');
    box.className = 'box';
    box.style.cssText = `left:${x1 / 10}%;top:${y1 / 10}%;width:${(x2 - x1) / 10}%;height:${(y2 - y1) / 10}%;--mark:${color}`;
    const label = document.createElement('span');
    label.className = `box-label${y1 < 50 ? ' inside' : ''}${x1 > 700 ? ' right' : ''}`;
    label.textContent = item.label;
    box.append(label);
    $('boxes').append(box);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result-item';
    button.setAttribute('aria-pressed', 'false');
    const name = document.createElement('span');
    name.className = 'label-name';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--mark', color);
    name.append(swatch, document.createTextNode(item.label));
    const coords = document.createElement('span');
    coords.className = 'coords';
    coords.textContent = item.bbox_2d.join(', ');
    button.append(name, coords);
    button.onclick = () => {
      selected = selected === index ? -1 : index;
      $('boxes').classList.toggle('is-highlighting', selected !== -1);
      [...$('boxes').children].forEach((el, i) => el.classList.toggle('active', i === selected));
      document.querySelectorAll('.result-item').forEach((el, i) => el.setAttribute('aria-pressed', String(i === selected)));
    };
    li.append(button);
    $('result-list').append(li);
  });
  $('boxes').hidden = !$('show-boxes').checked;
  renderView();
}
async function loadImage(file, name) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    $('file-error').textContent = '请选择不超过 10 MB 的 JPG、PNG 或 WebP 图片。';
    $('file-error').hidden = false;
    return;
  }
  const current = ++generation;
  $('file-error').hidden = true;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (current !== generation) { bitmap.close(); return; }
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    imageData = canvas.toDataURL('image/jpeg', .9);
    $('image').src = imageData;
    $('image-wrap').style.setProperty('--ratio', canvas.width / canvas.height);
    $('image-wrap').hidden = false;
    $('stage-empty').hidden = true;
    $('stage').setAttribute('aria-busy', 'false');
    $('filename').textContent = name;
    $('dimensions').textContent = `${canvas.width} × ${canvas.height}`;
    clearResult();
    updateControls();
  } catch {
    $('stage').setAttribute('aria-busy', 'false');
    $('stage-empty').textContent = '无法读取图片，请上传图片。';
    $('file-error').textContent = '无法读取图片，请选择有效的图片文件。';
    $('file-error').hidden = false;
  }
}
async function sample() {
  try {
    const response = await fetch('/street.jpg');
    if (!response.ok) throw new Error();
    await loadImage(await response.blob(), '街景样例');
  } catch {
    $('stage').setAttribute('aria-busy', 'false');
    $('stage-empty').textContent = '样例加载失败，请上传图片。';
  }
}
$('sample').onclick = sample;
$('upload').onclick = () => $('file').click();
$('file').onchange = e => { loadImage(e.target.files[0], e.target.files[0]?.name); e.target.value = ''; };
$('terms').oninput = updateControls;
$('presets').addEventListener('click', event => {
  const term = event.target.closest('button')?.dataset.term;
  if (!term) return;
  $('terms').value = term;
  updateControls();
});
$('show-boxes').onchange = e => { $('boxes').hidden = !e.target.checked; };
['list', 'json'].forEach(view => $(`view-${view}`).onclick = () => {
  $('view-list').setAttribute('aria-pressed', String(view === 'list'));
  $('view-json').setAttribute('aria-pressed', String(view === 'json'));
  renderView();
});
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(responseData, null, 2));
    $('copy').querySelector('span').textContent = '已复制';
    setTimeout(() => { $('copy').querySelector('span').textContent = '复制'; }, 1500);
  } catch { $('copy').querySelector('span').textContent = '复制失败'; }
};
for (const event of ['dragenter', 'dragover']) $('stage').addEventListener(event, e => { e.preventDefault(); $('stage').classList.add('dragging'); });
$('stage').addEventListener('dragleave', e => { if (!$('stage').contains(e.relatedTarget)) $('stage').classList.remove('dragging'); });
$('stage').addEventListener('drop', e => { e.preventDefault(); $('stage').classList.remove('dragging'); const file = e.dataTransfer.files[0]; if (file) loadImage(file, file.name); });
$('detect-form').onsubmit = async e => {
  e.preventDefault();
  if (busy || $('detect').disabled) return;
  const current = generation;
  const requestedTerms = terms();
  clearResult();
  busy = true;
  updateControls();
  $('result-empty').hidden = true;
  $('result-status').hidden = false;
  $('result-status').className = 'result-status';
  $('result-status').textContent = '正在分析图片…';
  try {
    const response = await fetch('/api/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: imageData, terms: requestedTerms }) });
    const data = await response.json();
    if (current !== generation) return;
    responseData = data;
    if (!response.ok) throw new Error(data.error || '检测失败，请重试。');
    detections = data.detections;
    $('result-status').replaceChildren(document.createTextNode(`检测到 ${detections.length} 个目标`));
    const elapsed = document.createElement('span');
    elapsed.className = 'elapsed';
    elapsed.textContent = `${(data.elapsedMs / 1000).toFixed(1)} s`;
    $('result-status').append(elapsed);
    renderResults();
  } catch (error) {
    if (current !== generation) return;
    $('result-status').textContent = error.message || '检测失败，请重试。';
    $('result-status').className = 'result-status error';
    renderView();
  } finally {
    busy = false;
    updateControls();
  }
};
sample();
