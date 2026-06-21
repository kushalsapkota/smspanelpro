// Generic Bearer-token JSON provider. Most REST SMS providers fit this with a field map.
// route.config can override: { fieldTo, fieldText, fieldFrom, authHeader, authScheme, respIdPath, extra }
const axios = require('axios');
const outbound = require('../shared/outbound');

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function send(route, dest, msg, source) {
  const c = route.config || {};
  const fieldTo = c.fieldTo || 'to';
  const fieldText = c.fieldText || 'text';
  const fieldFrom = c.fieldFrom || 'from';
  const respIdPath = c.respIdPath || 'message_id';

  const body = { [fieldTo]: dest, [fieldText]: msg };
  if (source || route.sender_id) body[fieldFrom] = source || route.sender_id;
  if (c.extra && typeof c.extra === 'object') Object.assign(body, c.extra);

  const headers = { 'Content-Type': 'application/json' };
  if (route.auth_token) headers[c.authHeader || 'Authorization'] = (c.authScheme || 'Bearer ') + route.auth_token;

  try {
    const method = (route.http_method || 'POST').toUpperCase();
    const url = route.api_url;
    const res = method === 'GET'
      ? await axios.get(url, outbound.cfg(route, { params: body, headers, timeout: 15000 }))
      : await axios(outbound.cfg(route, { method, url, data: body, headers, timeout: 15000 }));
    const messageId = getPath(res.data, respIdPath) || getPath(res.data, 'data.' + respIdPath) || ('' + Date.now());
    return { success: true, messageId: String(messageId), rawData: res.data };
  } catch (err) {
    return { success: false, error: err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message, rawData: err.response && err.response.data };
  }
}

module.exports = { send };
