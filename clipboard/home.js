const sitePath = window.eunNotePath || (path => path);
const token = window.eunNoteSession ? '' : new URLSearchParams(location.hash.slice(1)).get('key');
if (token) {
  document.querySelector('#clipboardLink').href = `${sitePath('/clipboard/')}#key=${encodeURIComponent(token)}`;
  document.querySelector('#noteLink').href = `${sitePath('/notion/')}#key=${encodeURIComponent(token)}`;
  document.querySelector('#shujiLink').href = `${sitePath('/shuji/')}#key=${encodeURIComponent(token)}`;
}
document.querySelector('#clock').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
