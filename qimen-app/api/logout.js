// api/logout.js
// 清掉登入憑證的cookie，等於登出。

module.exports = async function handler(req, res) {
  res.setHeader('Set-Cookie', `qimen_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.status(200).json({ ok: true });
};
