const eunNoteBase = new URL(document.currentScript.src).pathname.replace(/\/auth\/client\.js$/, '');
window.eunNotePath = path => eunNoteBase + path;
window.eunNoteMedia = value => typeof value === 'string' && value.startsWith('/notion/media/') ? window.eunNotePath(value) : value;
window.eunNoteSession = true;
if (new URLSearchParams(location.hash.slice(1)).has('key')) history.replaceState(null, '', location.pathname + location.search);
document.addEventListener('DOMContentLoaded', () => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '退出登录';
  button.className = 'session-logout';
  button.addEventListener('click', async () => {
    await fetch(window.eunNotePath('/auth/logout'), { method: 'POST', credentials: 'same-origin' });
    location.replace(window.eunNotePath('/auth/'));
  });
  const target = document.querySelector('.header-right') || document.querySelector('.top-actions') || document.querySelector('footer') || document.querySelector('header');
  target?.append(button);
});
