/**
 * Authentication module.
 * Локальная аутентификация — без сетевых запросов.
 * Сессия хранится в памяти (работает всегда) + дублируется в sessionStorage/localStorage.
 * Это решает проблему блокировки localStorage в Chrome/Яндекс внутри iframe.
 */

const SESSION_KEY = 'mto_auth_token';
const USER_KEY    = 'mto_auth_user';

// Учётные данные (один пользователь)
const VALID_USER = 'admin';
const VALID_PASS = 'admin';

// ── In-memory сессия (работает в любом браузере, в любом iframe) ──
let _memToken = null;
let _memUser  = null;

function makeToken(user) {
  return btoa(user + ':' + Date.now());
}

// Попытаться восстановить сессию из хранилища при загрузке модуля
(function restoreSession() {
  try {
    const t = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    const u = sessionStorage.getItem(USER_KEY)    || localStorage.getItem(USER_KEY);
    if (t && u) { _memToken = t; _memUser = u; }
  } catch { /* хранилище заблокировано — продолжаем без него */ }
})();

/** Сохранить сессию во все доступные хранилища */
function persistSession(token, user) {
  _memToken = token;
  _memUser  = user;
  try { sessionStorage.setItem(SESSION_KEY, token); sessionStorage.setItem(USER_KEY, user); } catch { /* */ }
  try { localStorage.setItem(SESSION_KEY, token);   localStorage.setItem(USER_KEY, user);   } catch { /* */ }
}

/** Удалить сессию отовсюду */
function clearSession() {
  _memToken = null;
  _memUser  = null;
  try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(USER_KEY); } catch { /* */ }
  try { localStorage.removeItem(SESSION_KEY);   localStorage.removeItem(USER_KEY);   } catch { /* */ }
}

/** Возвращает true если пользователь вошёл */
export function isLoggedIn() {
  return !!_memToken;
}

/** Возвращает имя текущего пользователя или null */
export function getCurrentUser() {
  return _memUser || null;
}

/** Возвращает токен сессии или null */
export function getToken() {
  return _memToken || null;
}

/**
 * Попытка входа — только локальная проверка, без сети.
 * Возвращает { ok: true } или { ok: false, error: string }
 */
export async function login(username, password) {
  if (!username || !password) {
    return { ok: false, error: 'Введите логин и пароль' };
  }
  if (username !== VALID_USER || password !== VALID_PASS) {
    return { ok: false, error: 'Неверный логин или пароль' };
  }
  const token = makeToken(username);
  persistSession(token, username);
  return { ok: true };
}

/** Выход и очистка сессии */
export function logout() {
  clearSession();
}
