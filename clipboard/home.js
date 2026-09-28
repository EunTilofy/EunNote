const token = new URLSearchParams(location.hash.slice(1)).get('key');
if (token) {
  document.querySelector('#clipboardLink').href = `/clipboard/#key=${encodeURIComponent(token)}`;
  document.querySelector('#noteLink').href = `/notion/#key=${encodeURIComponent(token)}`;
  document.querySelector('#shujiLink').href = `/shuji/#key=${encodeURIComponent(token)}`;
}
document.querySelector('#clock').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
