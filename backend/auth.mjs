// 口令与登录凭据的密码学原语：PBKDF2-SHA256 存密码，SHA-256 存会话令牌。
// 迭代次数受 Cloudflare Workers 免费计划 10ms CPU 预算约束（约 5.7ms/次）。
const SCHEME = 'pbkdf2-sha256';
export const ITERATIONS = 50_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS);
  return new Uint8Array(bits);
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${SCHEME}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

// 返回命中的迭代次数，便于登录后按更高强度重新哈希；不匹配返回 null。
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1_000_000) return null;
  let salt, expected;
  try { salt = fromBase64(parts[2]); expected = fromBase64(parts[3]); } catch { return null; }
  if (!salt.length || !expected.length) return null;
  const actual = await derive(password, salt, iterations);
  return equalBytes(actual, expected) ? { iterations } : null;
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
