const loginBase = location.pathname.replace(/\/auth\/$/, '');
const loginPath = path => loginBase + path;
const form = document.querySelector('#loginForm');
const input = document.querySelector('#accessCode');
const button = document.querySelector('#loginButton');
const error = document.querySelector('#loginError');
const requested = new URLSearchParams(location.search).get('next') || loginPath('/');
let destination = loginPath('/');
try {
  const target = new URL(requested, location.origin);
  if (target.origin === location.origin && target.pathname.startsWith(loginPath('/')) && !target.pathname.startsWith(loginPath('/auth'))) destination = target.pathname + target.search;
} catch {}
const initialKey = new URLSearchParams(location.hash.slice(1)).get('key');
history.replaceState(null, '', location.pathname + location.search);

async function login(key) {
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch(loginPath('/auth/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }), credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时无法登录，请稍后重试。');
    input.value = '';
    location.replace(destination);
  } catch (problem) {
    error.textContent = problem.message;
    error.hidden = false;
    button.disabled = false;
  }
}
form.addEventListener('submit', event => { event.preventDefault(); login(input.value.trim()); });
if (initialKey) login(initialKey);
