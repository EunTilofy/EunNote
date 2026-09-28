const editor = document.querySelector('#text');
const status = document.querySelector('#status');
const count = document.querySelector('#count');
const saveButton = document.querySelector('#save');
const copyButton = document.querySelector('#copy');
const token = new URLSearchParams(location.hash.slice(1)).get('key');
const backHome = document.querySelector('#backHome');
if (backHome && token) backHome.href = `/#key=${encodeURIComponent(token)}`;
let dirty = false;
let saving = false;
let loading = false;
let initialized = false;
let revision = -1;
let version = 0;
let timer;

function show(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}
function updateCount() {
  count.textContent = `${editor.value.length.toLocaleString()} 字符`;
}
function saved(at) {
  show(at ? `已保存 · ${new Date(at).toLocaleString()}` : '已连接，等待粘贴', 'saved');
}
async function request(method, body) {
  const response = await fetch('/api/text', {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(method === 'PUT' ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}) },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || `请求失败 (${response.status})`);
  }
  return response.json();
}
async function refresh() {
  if (!token || dirty || saving || loading) return;
  loading = true;
  const startVersion = version;
  try {
    const data = await request('GET');
    if (dirty || saving || version !== startVersion) return;
    if (revision !== data.revision) {
      editor.value = data.text;
      revision = data.revision;
      updateCount();
    }
    initialized = true;
    editor.disabled = saveButton.disabled = copyButton.disabled = false;
    saved(data.updatedAt);
  } catch (error) {
    if (!dirty && !saving) show(`连接失败：${error.message}，将自动重试`, 'error');
  } finally {
    loading = false;
  }
}
async function save() {
  clearTimeout(timer);
  if (!initialized || !dirty || saving) return;
  if (new Blob([editor.value]).size > 2 * 1024 * 1024) {
    show('文本超过 2 MiB，尚未保存，请缩短后重试', 'error');
    return;
  }
  saving = true;
  const startVersion = version;
  show('正在保存…');
  try {
    const data = await request('PUT', editor.value);
    revision = data.revision;
    if (version === startVersion) {
      dirty = false;
      saved(data.updatedAt);
    } else {
      show('有新修改，等待保存…');
    }
  } catch (error) {
    show(`尚未保存：${error.message}，将自动重试，请勿关闭页面`, 'error');
  } finally {
    saving = false;
    if (dirty) timer = setTimeout(save, 2000);
  }
}
editor.addEventListener('input', () => {
  dirty = true;
  version++;
  updateCount();
  show('有修改，等待保存…');
  clearTimeout(timer);
  timer = setTimeout(save, 400);
});
saveButton.addEventListener('click', save);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
});
window.addEventListener('beforeunload', (event) => {
  if (dirty || saving) {
    event.preventDefault();
    event.returnValue = '';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty) save();
  if (document.visibilityState === 'visible') refresh();
});
copyButton.addEventListener('click', async () => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(editor.value);
    } else {
      // Public HTTP pages need the legacy user-gesture copy path.
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.focus();
      editor.select();
      const copied = document.execCommand('copy');
      if (!copied) throw new Error('请按 Ctrl / ⌘ + C 复制已选中的全文');
      editor.setSelectionRange(start, end);
    }
    copyButton.textContent = '已复制';
    setTimeout(() => { copyButton.textContent = '复制全文'; }, 1500);
  } catch (error) {
    editor.focus();
    editor.select();
    show(`自动复制失败：${error.message}`, 'error');
  }
});
if (!token) {
  show('缺少访问密钥，请使用包含 #key=… 的完整网址', 'error');
} else {
  refresh();
  setInterval(() => {
    if (document.visibilityState === 'visible' && !dirty) refresh();
  }, 2000);
}
